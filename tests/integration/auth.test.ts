import { beforeEach, describe, expect, it } from 'vitest';

import { action as loginAction } from '~/routes/login';
import { loader as homeLoader } from '~/routes/home';

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
