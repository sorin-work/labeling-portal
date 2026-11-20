import { beforeEach, describe, expect, it } from 'vitest';

import { apiLimiter } from '~/lib/auth.server';
import { hashToken } from '~/lib/tokens.server';
import { createApiToken, revokeApiToken } from '~/models/api-tokens.server';
import { action as accountAction, loader as accountLoader } from '~/routes/account';
import { action as batchesAction } from '~/routes/api-v1-batches';
import { loader as exportLoader } from '~/routes/api-v1-export';
import { loader as projectLoader } from '~/routes/api-v1-project';
import { loader as projectsLoader } from '~/routes/api-v1-projects';
import { loader as tasksLoader } from '~/routes/api-v1-tasks';
import { loader as projectsPage } from '~/routes/projects';

import {
  cookieFor,
  createMember,
  createOrg,
  createTasks,
  createTestProject,
  makeRequest,
  payload,
  prisma,
  resetDb,
  run,
} from './helpers';

type Json = Record<string, unknown>;

async function setup(role: 'PROJECT_MANAGER' | 'REVIEWER' | 'ANNOTATOR' = 'PROJECT_MANAGER') {
  const org = await createOrg();
  const person = await createMember(org.id, role, { name: 'Pat' });
  const project = await createTestProject(org.id, { name: 'Sentiment' });
  const write = await createApiToken(org.id, person.id, {
    name: 'nightly',
    readOnly: false,
    expiresInDays: null,
  });
  const read = await createApiToken(org.id, person.id, {
    name: 'reader',
    readOnly: true,
    expiresInDays: 30,
  });
  return { org, person, project, write: write.token, read: read.token, readId: read.id };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function call(
  fn: (args: never) => unknown,
  path: string,
  init: { token?: string; headers?: Record<string, string>; body?: string; method?: string } = {},
  params: Record<string, string> = {},
) {
  const headers = { ...(init.token ? bearer(init.token) : {}), ...init.headers };
  const response = (await run(
    fn,
    makeRequest(path, { headers, body: init.body, method: init.method }),
    params,
  )) as Response;
  const text = await response.text();
  let json: Json | null = null;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    // a file, not JSON
  }
  return { status: response.status, json, text, headers: response.headers };
}

describe('tokens', () => {
  beforeEach(resetDb);

  it('are stored as a hash and a prefix, never as the token', async () => {
    const { write } = await setup();
    expect(write).toMatch(/^lp_[A-Za-z0-9_-]{43}$/);
    const stored = await prisma.apiToken.findMany();
    expect(JSON.stringify(stored)).not.toContain(write);
    expect(stored.map((t) => t.tokenHash)).toContain(hashToken(write));
    expect(stored.every((t) => write.startsWith(t.prefix) || t.prefix.length === 11)).toBe(true);
    // nor in the audit trail
    expect(JSON.stringify(await prisma.activity.findMany())).not.toContain(write);
  });

  it('are made, shown once, listed and revoked on the account page', async () => {
    const org = await createOrg();
    const pat = await createMember(org.id, 'PROJECT_MANAGER');
    const cookie = await cookieFor(pat, org.id);
    const made = payload<{ token: { value: string } }>(
      await run(
        accountAction,
        makeRequest('/account', {
          cookie,
          form: { intent: 'token-create', name: 'Pipeline', write: 'on', expiresInDays: '90' },
        }),
      ),
    );
    const token = made.token.value;
    const page = payload<{ tokens: Array<Json> }>(
      await run(accountLoader, makeRequest('/account', { cookie })),
    );
    expect(page.tokens).toEqual([
      expect.objectContaining({ name: 'Pipeline', readOnly: false, revokedAt: null }),
    ]);
    // the list never gives the token or its hash back
    expect(JSON.stringify(page)).not.toContain(token);
    expect(JSON.stringify(page)).not.toContain(hashToken(token));
    expect((await call(projectsLoader, '/api/v1/projects', { token })).status).toBe(200);

    await run(
      accountAction,
      makeRequest('/account', {
        cookie,
        form: { intent: 'token-revoke', tokenId: String(page.tokens[0].id) },
      }),
    );
    expect((await call(projectsLoader, '/api/v1/projects', { token })).status).toBe(401);
    expect(
      (await prisma.activity.findMany({ orderBy: { createdAt: 'asc' } })).map((a) => a.action),
    ).toEqual(['token.created', 'token.revoked']);
  });

  it('cannot be revoked by someone else', async () => {
    const { org, readId } = await setup();
    const other = await createMember(org.id, 'ADMIN');
    expect(await revokeApiToken(org.id, other.id, readId)).toEqual({ ok: false });
  });
});

describe('the api refuses', () => {
  beforeEach(resetDb);

  it('a request without a token, with a cookie only, or with a bad token, as JSON 401', async () => {
    const { org, person } = await setup();
    const cookie = await cookieFor(person, org.id);
    for (const headers of [
      {},
      { Cookie: cookie },
      bearer('lp_not-a-token'),
      bearer('something-else'),
      { Authorization: 'Basic abc' },
    ]) {
      const result = await call(projectsLoader, '/api/v1/projects', { headers });
      expect(result.status, JSON.stringify(headers)).toBe(401);
      expect(result.json?.error).toEqual(expect.any(String));
      expect(result.headers.get('Location')).toBeNull();
    }
  });

  it('a revoked or expired token, and one whose person left', async () => {
    const { org, person, read, readId, write } = await setup();
    await revokeApiToken(org.id, person.id, readId);
    expect((await call(projectsLoader, '/api/v1/projects', { token: read })).status).toBe(401);

    await prisma.apiToken.updateMany({
      where: { tokenHash: hashToken(write) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await call(projectsLoader, '/api/v1/projects', { token: write })).status).toBe(401);

    const other = await createApiToken(org.id, person.id, {
      name: 'x',
      readOnly: true,
      expiresInDays: null,
    });
    await prisma.membership.deleteMany({ where: { userId: person.id } });
    expect((await call(projectsLoader, '/api/v1/projects', { token: other.token })).status).toBe(
      401,
    );
  });

  it('a read-only token on a write, and the wrong method', async () => {
    const { project, read, write } = await setup();
    const path = `/api/v1/projects/${project.id}/batches`;
    const upload = (token: string) =>
      call(batchesAction, path, { token, body: 'text\nhello\n' }, { projectId: project.id });
    expect(await upload(read)).toMatchObject({
      status: 403,
      json: { error: 'This token is read-only.' },
    });
    expect(await prisma.batch.count()).toBe(0);
    // a write route answers only POST, a read route only GET
    expect(
      (await call(batchesAction, path, { token: write, method: 'GET' }, { projectId: project.id }))
        .status,
    ).toBe(405);
    expect(
      (await call(projectsLoader, '/api/v1/projects', { token: write, body: '', method: 'POST' }))
        .status,
    ).toBe(405);
  });

  it('another organisation’s project as 404, and a missing capability as 403', async () => {
    const { read } = await setup();
    const other = await createOrg('Other');
    const theirs = await createTestProject(other.id);
    const result = await call(
      projectLoader,
      `/api/v1/projects/${theirs.id}`,
      { token: read },
      {
        projectId: theirs.id,
      },
    );
    expect(result).toMatchObject({ status: 404, json: { error: 'Project not found' } });
    expect(
      (
        await call(
          exportLoader,
          `/api/v1/projects/${theirs.id}/export`,
          { token: read },
          {
            projectId: theirs.id,
          },
        )
      ).status,
    ).toBe(404);

    const annotator = await setup('ANNOTATOR');
    await prisma.projectMember.create({
      data: { projectId: annotator.project.id, userId: annotator.person.id },
    });
    // the same rule as the export page: annotators may not export
    expect(
      (
        await call(
          exportLoader,
          `/api/v1/projects/${annotator.project.id}/export`,
          { token: annotator.read },
          { projectId: annotator.project.id },
        )
      ).status,
    ).toBe(403);
  });

  it('more than the limit of requests a minute per token', async () => {
    const { read, write } = await setup();
    apiLimiter.reset(
      (await prisma.apiToken.findFirstOrThrow({ where: { tokenHash: hashToken(read) } })).id,
    );
    let last = 0;
    for (let i = 0; i < 121; i++) {
      last = (await call(projectsLoader, '/api/v1/projects', { token: read })).status;
    }
    expect(last).toBe(429);
    // another token has its own count
    expect((await call(projectsLoader, '/api/v1/projects', { token: write })).status).toBe(200);
  });
});

describe('the api', () => {
  beforeEach(resetDb);

  it('lists and shows projects as the pages do', async () => {
    const { org, person, project, read } = await setup();
    await createTasks(project.id, [{ text: 'a' }, { text: 'b' }]);
    const list = await call(projectsLoader, '/api/v1/projects', { token: read });
    const page = payload<{ projects: Array<{ id: string }> }>(
      await run(
        projectsPage,
        makeRequest('/projects', { cookie: await cookieFor(person, org.id) }),
      ),
    );
    expect((list.json?.projects as Array<{ id: string }>).map((p) => p.id)).toEqual(
      page.projects.map((p) => p.id),
    );
    const one = await call(
      projectLoader,
      `/api/v1/projects/${project.id}`,
      { token: read },
      {
        projectId: project.id,
      },
    );
    expect(one.json).toMatchObject({
      project: { id: project.id, name: 'Sentiment', schema: { kind: 'text_classification' } },
      progress: { tasks: 2, complete: 0 },
    });
  });

  it('imports a file all or nothing, with the same report as the page', async () => {
    const { project, write } = await setup();
    const path = `/api/v1/projects/${project.id}/batches?name=Tuesday`;
    const bad = await call(
      batchesAction,
      path,
      { token: write, body: 'text\nfine\n\n"open\n', headers: { 'Content-Type': 'text/csv' } },
      { projectId: project.id },
    );
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({
      errors: [{ line: 4, message: 'A quoted field starts here and is never closed' }],
    });
    expect(await prisma.task.count()).toBe(0);

    const good = await call(
      batchesAction,
      path,
      {
        token: write,
        body: '{"text":"one","id":"e1"}\n{"text":"two","id":"e2"}\n',
        headers: { 'Content-Type': 'application/x-ndjson' },
      },
      { projectId: project.id },
    );
    expect(good).toMatchObject({
      status: 201,
      json: { batch: { name: 'Tuesday', format: 'JSONL', tasks: 2 }, repeated: false },
    });
    const entry = await prisma.activity.findFirstOrThrow({ where: { action: 'batch.imported' } });
    expect(entry.detail).toMatchObject({ via: 'api', tasks: 2 });
  });

  it('creates one batch for a repeated Idempotency-Key, also when sent at once', async () => {
    const { project, write } = await setup();
    const send = () =>
      call(
        batchesAction,
        `/api/v1/projects/${project.id}/batches`,
        {
          token: write,
          body: 'text\nonly once\n',
          headers: { 'Content-Type': 'text/csv', 'Idempotency-Key': 'run-2026-03-01' },
        },
        { projectId: project.id },
      );
    const first = await send();
    const again = await send();
    expect(first.status).toBe(201);
    expect(again).toMatchObject({ status: 200, json: { repeated: true } });
    expect((again.json?.batch as Json).id).toBe((first.json?.batch as Json).id);
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await prisma.batch.count()).toBe(1);
    expect(await prisma.task.count()).toBe(1);
  });

  it('exports what the page exports, and the export imports back to the same tasks', async () => {
    const { org, person, project, write } = await setup();
    await createTasks(project.id, [{ text: 'alpha' }, { text: 'beta' }]);
    const exported = await call(
      exportLoader,
      `/api/v1/projects/${project.id}/export?format=jsonl&scope=all`,
      { token: write },
      { projectId: project.id },
    );
    expect(exported.status).toBe(200);
    const lines = exported.text.trim().split('\n');
    expect(lines).toHaveLength(2);

    const copy = await createTestProject(org.id, { name: 'Copy' });
    await prisma.projectMember.create({ data: { projectId: copy.id, userId: person.id } });
    const imported = await call(
      batchesAction,
      `/api/v1/projects/${copy.id}/batches`,
      { token: write, body: exported.text, headers: { 'Content-Type': 'application/x-ndjson' } },
      { projectId: copy.id },
    );
    expect(imported.status).toBe(201);
    const back = await prisma.task.findMany({
      where: { projectId: copy.id },
      orderBy: { position: 'asc' },
    });
    expect(back.map((t) => [t.externalId, (t.data as { text: string }).text])).toEqual([
      ['t1', 'alpha'],
      ['t2', 'beta'],
    ]);
    const entry = await prisma.activity.findFirstOrThrow({ where: { action: 'export.labels' } });
    expect(entry.detail).toMatchObject({ via: 'api', format: 'jsonl' });
  });

  it('finds a task by its external id, for managers and reviewers only', async () => {
    const { project, read } = await setup();
    await createTasks(project.id, [{ text: 'alpha' }]);
    const found = await call(
      tasksLoader,
      `/api/v1/projects/${project.id}/tasks?externalId=t1`,
      { token: read },
      { projectId: project.id },
    );
    expect(found.json).toMatchObject({
      tasks: [{ externalId: 't1', status: 'OPEN', consensus: null, agreement: null }],
    });
    const missing = await call(
      tasksLoader,
      `/api/v1/projects/${project.id}/tasks?externalId=zz`,
      { token: read },
      { projectId: project.id },
    );
    expect(missing.status).toBe(404);

    const annotator = await setup('ANNOTATOR');
    await prisma.projectMember.create({
      data: { projectId: annotator.project.id, userId: annotator.person.id },
    });
    expect(
      (
        await call(
          tasksLoader,
          `/api/v1/projects/${annotator.project.id}/tasks?externalId=t1`,
          { token: annotator.read },
          { projectId: annotator.project.id },
        )
      ).status,
    ).toBe(403);
  });

  it('notes when a token was used, at most once a minute', async () => {
    const { read } = await setup();
    const stored = () =>
      prisma.apiToken.findFirstOrThrow({ where: { tokenHash: hashToken(read) } });
    await call(projectsLoader, '/api/v1/projects', { token: read });
    const first = (await stored()).lastUsedAt;
    expect(first).not.toBeNull();
    await call(projectsLoader, '/api/v1/projects', { token: read });
    expect((await stored()).lastUsedAt).toEqual(first);
  });

  it('takes no token on a page', async () => {
    const { read } = await setup();
    const result = (await run(
      projectsPage,
      makeRequest('/projects', { headers: bearer(read) }),
    )) as Response;
    expect(result.status).toBe(302);
    expect(result.headers.get('Location')).toBe('/login?next=%2Fprojects');
  });
});
