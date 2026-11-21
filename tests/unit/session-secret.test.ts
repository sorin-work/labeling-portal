import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionSecret } from '~/lib/env.server';

describe('sessionSecret', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a published sample value in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'local-docker-session-secret-change-me-0123456789');
    expect(() => sessionSecret()).toThrow(/published sample/);
  });

  it('takes a secret of your own, and the sample outside production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'my-own-long-random-secret-123');
    expect(sessionSecret()).toBe('my-own-long-random-secret-123');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SESSION_SECRET', 'local-docker-session-secret-change-me-0123456789');
    expect(sessionSecret()).toBe('local-docker-session-secret-change-me-0123456789');
  });
});
