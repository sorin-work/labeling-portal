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

type RequestInit = { cookie?: string; form?: Record<string, string | string[]> };

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
