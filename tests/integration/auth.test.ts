import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signInPause } from '~/lib/rate-limit.server';

import { action as loginAction } from '~/routes/login';
import { loader as homeLoader } from '~/routes/dashboard';

import {
  cookieFor,
  createMember,
  createOrg,
  locationOf,
  makeRequest,
  payload,
  resetDb,
  run,
  statusOf,
} from './helpers';

describe('sign in', () => {
  beforeEach(resetDb);
  const savedProxy = process.env.TRUST_PROXY;
  afterEach(() => {
    if (savedProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = savedProxy;
  });

  it('signs a member in and redirects to the requested page', async () => {
    const org = await createOrg();
    await createMember(org.id, 'ANNOTATOR', { email: 'ann@example.test', password: 'secret-pass' });

    const result = await run(
      loginAction,
      makeRequest('/login', {
        form: { email: ' Ann@Example.test ', password: 'secret-pass', next: '/projects' },
      }),
    );

    expect(statusOf(result)).toBe(302);
    expect(locationOf(result)).toBe('/projects');
    expect((result as Response).headers.get('Set-Cookie')).toContain('__lp_session=');
  });

  it('rejects a wrong password', async () => {
    const org = await createOrg();
    await createMember(org.id, 'ANNOTATOR', { email: 'ann@example.test', password: 'secret-pass' });

    const result = await run(
      loginAction,
      makeRequest('/login', { form: { email: 'ann@example.test', password: 'nope' } }),
    );

    expect(statusOf(result)).toBe(401);
    expect(payload<{ error: string }>(result).error).toMatch(/do not match/);
  });

  it('blocks an email and address after too many wrong passwords', async () => {
    process.env.TRUST_PROXY = 'true';
    const org = await createOrg();
    await createMember(org.id, 'ANNOTATOR', {
      email: 'locked@example.test',
      password: 'secret-pass',
    });
    const attempt = (password: string) =>
      run(
        loginAction,
        makeRequest('/login', {
          form: { email: 'locked@example.test', password },
          headers: { 'X-Forwarded-For': '203.0.113.5' },
        }),
      );

    for (let i = 0; i < 10; i++) expect(statusOf(await attempt('wrong'))).toBe(401);
    const blocked = await attempt('secret-pass');
    expect(statusOf(blocked)).toBe(429);
    expect(payload<{ error: string }>(blocked).error).toMatch(/Too many attempts/);
  });

  it('without a known client address, slows wrong passwords and never refuses the right one', async () => {
    delete process.env.TRUST_PROXY;
    const waits: number[] = [];
    const spy = vi.spyOn(signInPause, 'wait').mockImplementation(async (ms) => {
      waits.push(ms);
    });
    try {
      const org = await createOrg();
      await createMember(org.id, 'ANNOTATOR', {
        email: 'slow@example.test',
        password: 'secret-pass',
      });
      const attempt = (password: string) =>
        run(loginAction, makeRequest('/login', { form: { email: 'slow@example.test', password } }));
      for (let i = 0; i < 10; i++) expect(statusOf(await attempt('wrong'))).toBe(401);
      expect(statusOf(await attempt('secret-pass'))).toBe(302);
      expect(waits).toEqual([0, 0, 0, 250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
    } finally {
      spy.mockRestore();
    }
  });

  it('gives a burst of parallel attempts no more tries than one at a time', async () => {
    process.env.TRUST_PROXY = 'true';
    const org = await createOrg();
    await createMember(org.id, 'ANNOTATOR', {
      email: 'burst@example.test',
      password: 'secret-pass',
    });
    const statuses = await Promise.all(
      Array.from({ length: 40 }, () =>
        run(
          loginAction,
          makeRequest('/login', {
            form: { email: 'burst@example.test', password: 'wrong' },
            headers: { 'X-Forwarded-For': '203.0.113.7' },
          }),
        ).then(statusOf),
      ),
    );
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30);
  });

  it('ignores off-site redirect targets', async () => {
    const org = await createOrg();
    await createMember(org.id, 'ADMIN', { email: 'admin@example.test', password: 'secret-pass' });

    const result = await run(
      loginAction,
      makeRequest('/login', {
        form: { email: 'admin@example.test', password: 'secret-pass', next: 'https://evil.test' },
      }),
    );

    expect(locationOf(result)).toBe('/');
  });

  it('sends anonymous visitors to the sign-in page', async () => {
    const result = await run(homeLoader, makeRequest('/'));
    expect(locationOf(result)).toBe('/login');
  });

  it('loads the home page for a signed-in member', async () => {
    const org = await createOrg();
    const user = await createMember(org.id, 'REVIEWER');
    const cookie = await cookieFor(user, org.id);

    const result = await run(homeLoader, makeRequest('/', { cookie }));

    expect(payload<{ role: string }>(result).role).toBe('REVIEWER');
  });
});
