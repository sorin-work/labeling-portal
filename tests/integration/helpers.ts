import type { Role } from '@prisma/client';

import { prisma } from '~/lib/db.server';
import { hashPassword } from '~/lib/password.server';
import { sessionStorage } from '~/lib/session.server';

export { prisma };

/** Empties every table except Prisma's migration bookkeeping. */
export async function resetDb() {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

let counter = 0;

export async function createOrg(name = 'Test Org') {
  counter += 1;
  return prisma.organization.create({ data: { name, slug: `test-org-${counter}` } });
}

export async function createMember(
  orgId: string,
  role: Role,
  opts: { email?: string; name?: string; password?: string } = {},
) {
  counter += 1;
  const user = await prisma.user.create({
    data: {
      email: opts.email ?? `${role.toLowerCase()}-${counter}@example.test`,
      name: opts.name ?? `${role.toLowerCase()} ${counter}`,
      passwordHash: await hashPassword(opts.password ?? 'password123'),
      memberships: { create: { orgId, role } },
    },
  });
  return user;
}

export async function cookieFor(user: { id: string }, orgId: string): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set('userId', user.id);
  session.set('orgId', orgId);
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(';')[0];
}

type FormValue = string | File;
type RequestInit = { cookie?: string; form?: Record<string, FormValue | FormValue[]> };

export function makeRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers();
  if (init.cookie) headers.set('Cookie', init.cookie);
  const url = `http://localhost${path}`;
  if (!init.form) return new Request(url, { headers });
  const body = new FormData();
  for (const [key, value] of Object.entries(init.form)) {
    for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
  }
  return new Request(url, { method: 'POST', headers, body });
}

type RouteFn = (args: never) => unknown;

/**
 * Runs a route loader or action the way React Router would and returns what it
 * produced. Thrown responses (redirects, 4xx) are returned instead of rethrown
 * so tests can assert on them.
 */
export async function run<F extends RouteFn>(
  fn: F,
  request: Request,
  params: Record<string, string> = {},
): Promise<unknown> {
  try {
    return await fn({ request, params, context: {} } as never);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

/** Unwraps `data()` results and plain objects returned by loaders and actions. */
export function payload<T = Record<string, unknown>>(result: unknown): T {
  if (result && typeof result === 'object' && 'type' in result && 'data' in result) {
    return (result as { data: T }).data;
  }
  return result as T;
}

export function statusOf(result: unknown): number {
  if (result instanceof Response) return result.status;
  if (result && typeof result === 'object' && 'init' in result) {
    const init = (result as { init?: { status?: number } | null }).init;
    return init?.status ?? 200;
  }
  return 200;
}

export function locationOf(result: unknown): string | null {
  return result instanceof Response ? result.headers.get('Location') : null;
}

export async function createTestProject(
  orgId: string,
  overrides: Partial<{
    name: string;
    schema: object;
    status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
    overlap: number;
    timeLimitMinutes: number;
    reviewRequired: boolean;
    instructions: string;
  }> = {},
) {
  const schema = overrides.schema ?? {
    kind: 'text_classification',
    textField: 'text',
    labels: ['positive', 'negative'],
    multiple: false,
  };
  const kinds: Record<string, 'TEXT_CLASSIFICATION' | 'NER' | 'PAIRWISE' | 'BBOX'> = {
    text_classification: 'TEXT_CLASSIFICATION',
    ner: 'NER',
    pairwise: 'PAIRWISE',
    bbox: 'BBOX',
  };
  return prisma.project.create({
    data: {
      orgId,
      name: overrides.name ?? 'Sentiment',
      schema,
      kind: kinds[(schema as { kind: string }).kind],
      status: overrides.status ?? 'ACTIVE',
      overlap: overrides.overlap ?? 1,
      timeLimitMinutes: overrides.timeLimitMinutes ?? 30,
      reviewRequired: overrides.reviewRequired ?? true,
      instructions: overrides.instructions ?? '',
    },
  });
}

export async function createTasks(projectId: string, rows: Array<Record<string, unknown>>) {
  const batch = await prisma.batch.create({ data: { projectId, name: 'batch', format: 'JSONL' } });
  const last = await prisma.task.aggregate({ where: { projectId }, _max: { position: true } });
  const start = (last._max.position ?? 0) + 1;
  await prisma.task.createMany({
    data: rows.map((data, i) => ({
      projectId,
      batchId: batch.id,
      position: start + i,
      externalId: `t${start + i}`,
      data: data as object,
    })),
  });
  return prisma.task.findMany({ where: { batchId: batch.id }, orderBy: { position: 'asc' } });
}

export async function addToProject(projectId: string, ...users: Array<{ id: string }>) {
  await prisma.projectMember.createMany({
    data: users.map((u) => ({ projectId, userId: u.id })),
    skipDuplicates: true,
  });
}

/** Claims and submits a task for a user directly through the queue functions. */
export async function submitWork(
  project: { id: string },
  userId: string,
  answer: object,
  opts: { activeSeconds?: number; now?: Date } = {},
) {
  const { claimNextTask, submitAssignment } = await import('~/models/queue.server');
  const fresh = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  // claim a few minutes in the past so the reported working time fits
  const claimedAt = opts.now ?? new Date(Date.now() - 10 * 60_000);
  const claim = await claimNextTask(fresh, userId, claimedAt);
  if (!claim.ok) throw new Error(`nothing to claim: ${claim.reason}`);
  const result = await submitAssignment(
    claim.assignment.id,
    userId,
    { answer, activeSeconds: opts.activeSeconds ?? 30, reviewRequired: fresh.reviewRequired },
    new Date(claimedAt.getTime() + 5 * 60_000),
  );
  if (!result.ok) throw new Error(result.error);
  return result.assignment;
}
