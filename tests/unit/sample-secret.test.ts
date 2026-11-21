import { afterEach, describe, expect, it, vi } from 'vitest';

import { isSampleSessionSecret, refuseSampleSecretOffLocalhost } from '~/lib/env.server';

const SAMPLE = 'local-docker-session-secret-change-me-0123456789';

describe('the sample session secret', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is accepted on localhost and refused under another host in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', SAMPLE);
    expect(isSampleSessionSecret()).toBe(true);
    for (const url of ['http://localhost:4421/', 'http://127.0.0.1/login', 'http://[::1]:3000/']) {
      expect(() => refuseSampleSecretOffLocalhost(new Request(url)), url).not.toThrow();
    }
    let thrown: unknown;
    try {
      refuseSampleSecretOffLocalhost(new Request('https://labels.example.com/login'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(503);
  });

  it('does not matter with a secret of your own, or outside production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'my-own-long-random-secret-123');
    expect(() =>
      refuseSampleSecretOffLocalhost(new Request('https://labels.example.com/')),
    ).not.toThrow();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SESSION_SECRET', SAMPLE);
    expect(isSampleSessionSecret()).toBe(false);
  });
});
