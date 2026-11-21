import { beforeEach, describe, expect, it } from 'vitest';

import { authenticate, getCurrentUser } from '~/lib/auth.server';
import { createApiToken } from '~/models/api-tokens.server';
import { action as accountAction, loader as accountLoader } from '~/routes/account';
import { action as draftAction } from '~/routes/work-draft';

import {
  cookieFor,
  createMember,
  createOrg,
  locationOf,
  makeRequest,
  payload,
  prisma,
  resetDb,
  run,
  statusOf,
} from './helpers';

describe('account', () => {
  beforeEach(resetDb);

  async function setup() {
    const org = await createOrg();
    const user = await createMember(org.id, 'ANNOTATOR', {
      email: 'me@example.test',
      password: 'old-password',
    });
    return { user, cookie: await cookieFor(user, org.id) };
  }

  it('changes the password', async () => {
    const { cookie } = await setup();
    const result = await run(
      accountAction,
      makeRequest('/account', {
        cookie,
        form: { current: 'old-password', next: 'new-password', confirm: 'new-password' },
      }),
    );
    expect(payload<{ message: string }>(result).message).toBe(
      'Password changed. You are signed out in every other browser.',
    );
    expect(await authenticate('me@example.test', 'new-password')).not.toBeNull();
    expect(await authenticate('me@example.test', 'old-password')).toBeNull();
  });

  it('checks the current password and the confirmation', async () => {
    const { cookie } = await setup();
    const wrong = await run(
      accountAction,
      makeRequest('/account', {
        cookie,
        form: { current: 'nope', next: 'new-password', confirm: 'new-password' },
      }),
    );
    expect(statusOf(wrong)).toBe(400);
    const mismatch = await run(
      accountAction,
      makeRequest('/account', {
        cookie,
        form: { current: 'old-password', next: 'new-password', confirm: 'other-pass' },
      }),
    );
    expect(payload<{ field: string }>(mismatch).field).toBe('confirm');
  });

  /** whether a request with this cookie is signed in */
  async function signedIn(cookie: string) {
    return (await getCurrentUser(makeRequest('/account', { cookie }))) !== null;
  }

  it('accepts a cookie made before session versions, and one with the current version', async () => {
    const { user } = await setup();
    const org = await prisma.membership.findFirstOrThrow({ where: { userId: user.id } });
    expect(await signedIn(await cookieFor(user, org.orgId))).toBe(true);
    expect(await signedIn(await cookieFor(user, org.orgId, 0))).toBe(true);
    expect(await signedIn(await cookieFor(user, org.orgId, 1))).toBe(false);
  });

  it('signs out every other browser on a password change and keeps this tab signed in', async () => {
    const { user, cookie } = await setup();
    const org = await prisma.membership.findFirstOrThrow({ where: { userId: user.id } });
    const otherBrowser = await cookieFor(user, org.orgId);
    await createApiToken(org.orgId, user.id, {
      name: 'Nightly',
      readOnly: true,
      expiresInDays: null,
    });
    const result = await run(
      accountAction,
      makeRequest('/account', {
        cookie,
        form: { current: 'old-password', next: 'new-password', confirm: 'new-password' },
      }),
    );
    expect(payload<{ message: string }>(result).message).toBe(
      'Password changed. You are signed out in every other browser. Your API token still works: revoke it below if someone else may have it.',
    );
    const setCookie = (result as { init: { headers: Record<string, string> } }).init.headers[
      'Set-Cookie'
    ];
    const fresh = setCookie.split(';')[0];
    expect(await signedIn(fresh)).toBe(true);
    expect(await signedIn(cookie)).toBe(false);
    expect(await signedIn(otherBrowser)).toBe(false);
    // a page in the other browser goes to the sign-in page
    expect(
      locationOf(await run(accountLoader, makeRequest('/account', { cookie: otherBrowser }))),
    ).toBe('/login?next=%2Faccount');
  });

  it('signs out everywhere, this browser too, and records it', async () => {
    const { user, cookie } = await setup();
    const org = await prisma.membership.findFirstOrThrow({ where: { userId: user.id } });
    const otherBrowser = await cookieFor(user, org.orgId);
    const result = await run(
      accountAction,
      makeRequest('/account', { cookie, form: { intent: 'sessions' } }),
    );
    expect(locationOf(result)).toBe('/login');
    expect(await signedIn(cookie)).toBe(false);
    expect(await signedIn(otherBrowser)).toBe(false);
    // the password still works, so signing in again gives a cookie that counts
    expect(await authenticate('me@example.test', 'old-password')).not.toBeNull();
    expect(await signedIn(await cookieFor(user, org.orgId, 1))).toBe(true);
    const entries = await prisma.activity.findMany({ where: { action: 'person.sessions_ended' } });
    expect(entries).toEqual([
      expect.objectContaining({
        actorId: user.id,
        detail: { userId: user.id, userName: user.name, own: true },
      }),
    ]);
  });

  it('stops a draft save from a page whose session ended with a redirect to sign in', async () => {
    const { user, cookie } = await setup();
    await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: 1 } });
    const result = await run(
      draftAction,
      makeRequest('/work/a1/draft', { cookie, form: { draft: '{"labels":["positive"]}' } }),
      { assignmentId: 'a1' },
    );
    // the page's fetch follows this and gets the sign-in page: "Draft not saved"
    expect(locationOf(result)).toBe(`/login?next=${encodeURIComponent('/work/a1/draft')}`);
  });
});
