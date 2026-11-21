import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, timeStep, totp } from '~/domain/totp';
import { getCurrentUser } from '~/lib/auth.server';
import { sealSecret } from '~/lib/secret-box.server';
import { pendingTwoStepSecret } from '~/models/two-step.server';
import { action as accountAction, loader as accountLoader } from '~/routes/account';
import { action as loginAction } from '~/routes/login';
import { action as twoStepAction, loader as twoStepLoader } from '~/routes/login-two-step';
import { action as peopleAction } from '~/routes/people';
import { loader as projectsLoader } from '~/routes/projects';

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

/** The cookie a response sets, as a request would send it back. */
function cookieOf(result: unknown): string {
  const headers =
    result instanceof Response
      ? result.headers
      : new Headers((result as { init: { headers: HeadersInit } }).init.headers);
  return (headers.get('Set-Cookie') ?? '').split(';')[0];
}

async function signedIn(cookie: string) {
  return (await getCurrentUser(makeRequest('/projects', { cookie }))) !== null;
}

/** Turns two-step on for a user directly, as a finished setup leaves it. */
async function withTwoStep(userId: string, lastStep: number | null = null) {
  const secret = newTotpSecret();
  const codes = newRecoveryCodes();
  await prisma.user.update({
    where: { id: userId },
    data: {
      totpSecret: sealSecret(secret),
      totpEnabledAt: new Date(),
      totpLastStep: lastStep,
      recoveryCodes: { create: codes.map((c) => ({ codeHash: hashRecoveryCode(c) })) },
    },
  });
  return { secret, codes };
}

/** The password page, then the cookie that holds the pending sign-in. */
async function password(email: string, headers?: Record<string, string>) {
  const result = await run(
    loginAction,
    makeRequest('/login', { form: { email, password: 'password123' }, headers }),
  );
  return { result, cookie: cookieOf(result) };
}

function secondStep(cookie: string, code: string, headers?: Record<string, string>) {
  return run(
    twoStepAction,
    makeRequest('/login/two-step', { cookie, form: { code, next: '/projects' }, headers }),
  );
}

describe('two-step sign-in', () => {
  beforeEach(resetDb);
  const savedProxy = process.env.TRUST_PROXY;
  afterEach(() => {
    process.env.TRUST_PROXY = savedProxy;
  });

  it('is set up with a code from the new secret, ends other sessions and gives ten codes', async () => {
    const org = await createOrg();
    const ann = await createMember(org.id, 'ANNOTATOR');
    const cookie = await cookieFor(ann, org.id);
    const otherBrowser = await cookieFor(ann, org.id);
    await run(
      accountAction,
      makeRequest('/account', { cookie, form: { intent: 'two-step-start' } }),
    );
    const secret = await pendingTwoStepSecret(ann.id);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    // stored encrypted, never as the secret itself
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: ann.id } });
    expect(stored.totpPending).not.toContain(secret!);
    const page = payload<{ twoStep: { setup: { qr: string } } }>(
      await run(accountLoader, makeRequest('/account', { cookie })),
    );
    expect(page.twoStep.setup.qr).toContain('<svg');

    const wrong = await run(
      accountAction,
      makeRequest('/account', { cookie, form: { intent: 'two-step-confirm', code: '000000' } }),
    );
    expect(statusOf(wrong)).toBe(400);

    const done = await run(
      accountAction,
      makeRequest('/account', {
        cookie,
        form: { intent: 'two-step-confirm', code: totp(secret!, new Date()) },
      }),
    );
    expect(payload<{ recoveryCodes: string[] }>(done).recoveryCodes).toHaveLength(10);
    expect(await prisma.recoveryCode.count({ where: { userId: ann.id } })).toBe(10);
    expect(await signedIn(cookieOf(done))).toBe(true);
    expect(await signedIn(otherBrowser)).toBe(false);
    expect(await prisma.activity.findMany({ where: { action: 'account.two_step' } })).toEqual([
      expect.objectContaining({ detail: { on: true } }),
    ]);
  });

  it('signs in after the password and a right code, and only then', async () => {
    const org = await createOrg();
    const ann = await createMember(org.id, 'ANNOTATOR', { email: 'two@example.test' });
    const { secret } = await withTwoStep(ann.id);

    const { result, cookie } = await password('two@example.test');
    expect(locationOf(result)).toBe('/login/two-step');
    // the pending sign-in is no session
    expect(await signedIn(cookie)).toBe(false);
    expect(statusOf(await run(twoStepLoader, makeRequest('/login/two-step', { cookie })))).toBe(
      200,
    );
    expect(await prisma.activity.count({ where: { action: 'auth.signed_in' } })).toBe(0);

    const done = await secondStep(cookie, totp(secret, new Date()));
    expect(locationOf(done)).toBe('/projects');
    expect(await signedIn(cookieOf(done))).toBe(true);
    expect(await prisma.activity.findMany({ where: { action: 'auth.signed_in' } })).toEqual([
      expect.objectContaining({ detail: { twoStep: 'code' } }),
    ]);
  });

  it('signs in with the password alone when two-step is off', async () => {
    const org = await createOrg();
    await createMember(org.id, 'ANNOTATOR', { email: 'one@example.test' });
    const { result, cookie } = await password('one@example.test');
    expect(locationOf(result)).toBe('/');
    expect(await signedIn(cookie)).toBe(true);
  });

  it('refuses a code that was used already', async () => {
    const org = await createOrg();
    const ann = await createMember(org.id, 'ANNOTATOR', { email: 'replay@example.test' });
    const { secret } = await withTwoStep(ann.id, timeStep(new Date()) - 2);
    const code = totp(secret, new Date());

    const first = await password('replay@example.test');
    expect(locationOf(await secondStep(first.cookie, code))).toBe('/projects');
    const second = await password('replay@example.test');
    const again = await secondStep(second.cookie, code);
    expect(statusOf(again)).toBe(401);
    expect(payload<{ error: string }>(again).error).toContain('used already');
  });

  it('takes a recovery code once', async () => {
    const org = await createOrg();
    const ann = await createMember(org.id, 'ANNOTATOR', { email: 'lost@example.test' });
    const { codes } = await withTwoStep(ann.id);

    const first = await password('lost@example.test');
    const used = await secondStep(first.cookie, codes[3].toUpperCase());
    expect(locationOf(used)).toBe('/account?recovery=used');
    expect(await signedIn(cookieOf(used))).toBe(true);
    const second = await password('lost@example.test');
    expect(statusOf(await secondStep(second.cookie, codes[3]))).toBe(401);
    expect(await prisma.recoveryCode.count({ where: { userId: ann.id, usedAt: null } })).toBe(9);
  });

  it('limits wrong codes per account and address, and records the lockout once', async () => {
    process.env.TRUST_PROXY = 'true';
    const org = await createOrg();
    const ann = await createMember(org.id, 'ANNOTATOR', { email: 'guess@example.test' });
    const { secret } = await withTwoStep(ann.id);
    const elsewhere = { 'X-Forwarded-For': '203.0.113.9' };
    const { cookie } = await password('guess@example.test', elsewhere);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push(statusOf(await secondStep(cookie, '000000', elsewhere)));
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    expect(await prisma.activity.count({ where: { action: 'auth.two_step_locked' } })).toBe(1);

    // the owner, from their own address, still gets in
    const home = { 'X-Forwarded-For': '198.51.100.4' };
    const owner = await password('guess@example.test', home);
    expect(locationOf(await secondStep(owner.cookie, totp(secret, new Date()), home))).toBe(
      '/projects',
    );
  });

  it('sends an admin or manager without it to the account page once the rule is on', async () => {
    const org = await createOrg();
    const admin = await createMember(org.id, 'ADMIN');
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const ann = await createMember(org.id, 'ANNOTATOR');
    const adminCookie = await cookieFor(admin, org.id);
    const rule = () =>
      run(
        peopleAction,
        makeRequest('/people', {
          cookie: adminCookie,
          form: { intent: 'two-step-rule', required: 'on' },
        }),
      );
    // not before the admin has their own
    expect(statusOf(await rule())).toBe(400);
    await withTwoStep(admin.id);
    expect(statusOf(await rule())).toBe(200);
    expect(await prisma.activity.count({ where: { action: 'org.two_step_rule' } })).toBe(1);

    const pmCookie = await cookieFor(pm, org.id);
    expect(
      locationOf(await run(projectsLoader, makeRequest('/projects', { cookie: pmCookie }))),
    ).toBe('/account?twoStep=required');
    const page = payload<{ twoStep: { mustSetUp: boolean } }>(
      await run(accountLoader, makeRequest('/account', { cookie: pmCookie })),
    );
    expect(page.twoStep.mustSetUp).toBe(true);
    // an annotator is not asked
    const annPage = await run(
      projectsLoader,
      makeRequest('/projects', { cookie: await cookieFor(ann, org.id) }),
    );
    expect(locationOf(annPage)).toBeNull();
    // and the admin cannot turn their own off while the rule is on
    const off = await run(
      accountAction,
      makeRequest('/account', {
        cookie: adminCookie,
        form: { intent: 'two-step-off', code: '000000' },
      }),
    );
    expect(payload<{ twoStepError: string }>(off).twoStepError).toContain('keep it on');
  });

  it('lets an admin reset it, which ends the person’s sessions and is recorded', async () => {
    const org = await createOrg();
    const admin = await createMember(org.id, 'ADMIN');
    const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
    await withTwoStep(ann.id);
    const theirs = await cookieFor(ann, org.id);
    const result = await run(
      peopleAction,
      makeRequest('/people', {
        cookie: await cookieFor(admin, org.id),
        form: { intent: 'two-step-reset', userId: ann.id },
      }),
    );
    expect(statusOf(result)).toBe(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ann.id } })).toMatchObject({
      totpSecret: null,
      totpEnabledAt: null,
      totpLastStep: null,
    });
    expect(await prisma.recoveryCode.count({ where: { userId: ann.id } })).toBe(0);
    expect(await signedIn(theirs)).toBe(false);
    expect(await prisma.activity.findMany({ where: { action: 'person.two_step_reset' } })).toEqual([
      expect.objectContaining({ actorId: admin.id, detail: { userId: ann.id, userName: 'Ann' } }),
    ]);
  });
});
