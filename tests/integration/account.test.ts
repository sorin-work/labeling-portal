import { beforeEach, describe, expect, it } from 'vitest';

import { authenticate } from '~/lib/auth.server';
import { action as accountAction } from '~/routes/account';

import {
  cookieFor,
  createMember,
  createOrg,
  makeRequest,
  payload,
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
    expect(payload<{ message: string }>(result).message).toBe('Password changed.');
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
});
