import { beforeEach, describe, expect, it } from 'vitest';

import { getCurrentUser, requireApiUser } from '~/lib/auth.server';
import { createApiToken } from '~/models/api-tokens.server';
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

  it('sets a new password for a member', async () => {
    const { org, cookie } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR', { email: 'forgot@example.test' });
    await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: { intent: 'password', userId: ann.id, password: 'brand-new-pass' },
      }),
    );
    const { authenticate } = await import('~/lib/auth.server');
    expect(await authenticate('forgot@example.test', 'brand-new-pass')).not.toBeNull();

    const short = await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: { intent: 'password', userId: ann.id, password: 'x' },
      }),
    );
    expect(statusOf(short)).toBe(400);
  });

  async function signedIn(cookie: string) {
    return (await getCurrentUser(makeRequest('/projects', { cookie }))) !== null;
  }

  it('ends every session of a member when an admin sets their password', async () => {
    const { org, cookie } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR');
    const theirs = await cookieFor(ann, org.id);
    expect(await signedIn(theirs)).toBe(true);
    await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: { intent: 'password', userId: ann.id, password: 'brand-new-pass' },
      }),
    );
    expect(await signedIn(theirs)).toBe(false);
    // the admin who did it is not signed out
    expect(await signedIn(cookie)).toBe(true);
  });

  it('ends sessions, names the tokens that still work and lets the admin revoke them', async () => {
    const { org, admin, cookie } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
    const theirs = await cookieFor(ann, org.id);
    const token = await createApiToken(org.id, ann.id, {
      name: 'Nightly',
      readOnly: true,
      expiresInDays: null,
    });
    const ended = await run(
      peopleAction,
      makeRequest('/people', { cookie, form: { intent: 'sessions', userId: ann.id } }),
    );
    expect(await signedIn(theirs)).toBe(false);
    const result = payload<{ tokens: { name: string; list: Array<{ id: string; name: string }> } }>(
      ended,
    );
    expect(result.tokens.name).toBe('Ann');
    expect(result.tokens.list).toEqual([
      expect.objectContaining({ id: token.id, name: 'Nightly' }),
    ]);

    const revoked = await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: { intent: 'token-revoke', userId: ann.id, tokenId: token.id },
      }),
    );
    expect(payload<{ tokens?: unknown }>(revoked).tokens).toBeUndefined();
    expect(
      (await prisma.apiToken.findUniqueOrThrow({ where: { id: token.id } })).revokedAt,
    ).not.toBeNull();

    const entries = await prisma.activity.findMany({ orderBy: { createdAt: 'asc' } });
    expect(entries.filter((e) => e.action !== 'token.created')).toEqual([
      expect.objectContaining({
        action: 'person.sessions_ended',
        actorId: admin.id,
        detail: { userId: ann.id, userName: 'Ann', own: false },
      }),
      expect.objectContaining({
        action: 'token.revoked',
        actorId: admin.id,
        detail: expect.objectContaining({ userId: ann.id, userName: 'Ann', name: 'Nightly' }),
      }),
    ]);

    // not for your own sessions here, and not for a token of someone else's id
    const self = await run(
      peopleAction,
      makeRequest('/people', { cookie, form: { intent: 'sessions', userId: admin.id } }),
    );
    expect(statusOf(self)).toBe(400);
    const other = await createMember(org.id, 'ANNOTATOR');
    const otherToken = await createApiToken(org.id, other.id, {
      name: 'Other',
      readOnly: true,
      expiresInDays: null,
    });
    const mismatched = await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: { intent: 'token-revoke', userId: ann.id, tokenId: otherToken.id },
      }),
    );
    expect(statusOf(mismatched)).toBe(404);
  });

  it('does not let an old cookie or token back in after a remove and a re-add', async () => {
    const { org, cookie } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR', {
      name: 'Ann',
      email: 'ann-again@example.test',
    });
    const theirs = await cookieFor(ann, org.id);
    const token = await createApiToken(org.id, ann.id, {
      name: 'Nightly',
      readOnly: true,
      expiresInDays: null,
    });
    await run(
      peopleAction,
      makeRequest('/people', { cookie, form: { intent: 'remove', userId: ann.id } }),
    );
    await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: {
          intent: 'add',
          name: 'Ann',
          email: 'ann-again@example.test',
          role: 'ANNOTATOR',
          password: 'whatever-1',
        },
      }),
    );
    expect(await prisma.membership.count({ where: { userId: ann.id } })).toBe(1);
    expect(await signedIn(theirs)).toBe(false);
    const api = await requireApiUser(
      makeRequest('/api/v1/projects', { headers: { Authorization: `Bearer ${token.token}` } }),
    ).catch((error: unknown) => error);
    expect(statusOf(api)).toBe(401);
  });

  it('refuses a token of someone in another organisation, and its own password or sessions', async () => {
    const { org, admin, cookie } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR');
    const elsewhere = await createOrg('Elsewhere');
    await prisma.membership.create({
      data: { orgId: elsewhere.id, userId: ann.id, role: 'ANNOTATOR' },
    });
    const foreign = await createApiToken(elsewhere.id, ann.id, {
      name: 'Other org',
      readOnly: true,
      expiresInDays: null,
    });
    const revoke = await run(
      peopleAction,
      makeRequest('/people', {
        cookie,
        form: { intent: 'token-revoke', userId: ann.id, tokenId: foreign.id },
      }),
    );
    expect(statusOf(revoke)).toBe(404);
    expect(payload<{ error: string }>(revoke).error).toContain('not found');
    expect(
      (await prisma.apiToken.findUniqueOrThrow({ where: { id: foreign.id } })).revokedAt,
    ).toBeNull();

    const own: Array<Record<string, string>> = [
      { intent: 'password', userId: admin.id, password: 'brand-new-pass' },
      { intent: 'sessions', userId: admin.id },
    ];
    for (const form of own) {
      const result = await run(peopleAction, makeRequest('/people', { cookie, form }));
      expect(statusOf(result)).toBe(400);
      expect(payload<{ error: string }>(result).error).toContain('account page');
    }
    expect(await signedIn(cookie)).toBe(true);
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
