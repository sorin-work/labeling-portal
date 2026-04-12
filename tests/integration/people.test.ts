import { beforeEach, describe, expect, it } from 'vitest';

import { action as peopleAction, loader as peopleLoader } from '~/routes/people';

import {
  cookieFor,
  createMember,
  createOrg,
  makeRequest,
  payload,
  prisma,
  resetDb,
  run,
  statusOf,
} from './helpers';

async function setup() {
  const org = await createOrg();
  const admin = await createMember(org.id, 'ADMIN');
  return { org, admin, cookie: await cookieFor(admin, org.id) };
}

describe('people admin', () => {
  beforeEach(resetDb);

  it('adds a new person with a login', async () => {
    const { org, cookie } = await setup();
    const result = await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: {
          intent: 'add',
          name: 'Dana',
          email: 'Dana@Example.test',
          role: 'REVIEWER',
          password: 'temporary1',
        },
      }),
    );
    expect(payload<{ message: string }>(result).message).toBe('Dana was added.');
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'dana@example.test' },
      include: { memberships: true },
    });
    expect(user.memberships).toEqual([
      expect.objectContaining({ orgId: org.id, role: 'REVIEWER' }),
    ]);
  });

  it('validates the form', async () => {
    const { cookie } = await setup();
    const result = await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: { intent: 'add', name: 'D', email: 'nope', role: 'ANNOTATOR', password: 'short' },
      }),
    );
    expect(statusOf(result)).toBe(400);
    expect(Object.keys(payload<{ errors: object }>(result).errors).sort()).toEqual([
      'email',
      'name',
      'password',
    ]);
  });

  it('refuses duplicates in the same organisation', async () => {
    const { org, cookie } = await setup();
    await createMember(org.id, 'ANNOTATOR', { email: 'taken@example.test' });
    const result = await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: {
          intent: 'add',
          name: 'Again',
          email: 'taken@example.test',
          role: 'ANNOTATOR',
          password: 'password1',
        },
      }),
    );
    expect(statusOf(result)).toBe(400);
  });

  it('changes roles but not your own', async () => {
    const { org, admin, cookie } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR');
    await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: { intent: 'role', userId: ann.id, role: 'REVIEWER' },
      }),
    );
    expect((await prisma.membership.findFirstOrThrow({ where: { userId: ann.id } })).role).toBe(
      'REVIEWER',
    );

    const self = await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: { intent: 'role', userId: admin.id, role: 'ANNOTATOR' },
      }),
    );
    expect(statusOf(self)).toBe(400);
  });

  it('removes someone from the organisation and their projects', async () => {
    const { org, cookie } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR');
    await run(
      peopleAction,
      makeRequest('/people', { cookie, form: { intent: 'remove', userId: ann.id } }),
    );
    expect(await prisma.membership.count({ where: { userId: ann.id } })).toBe(0);
  });

  it('is only for admins', async () => {
    const { org } = await setup();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const result = await run(
      peopleLoader,
      makeRequest('/people', { cookie: await cookieFor(pm, org.id) }),
    );
    expect(statusOf(result)).toBe(403);
  });
});
