import { describe, expect, it } from 'vitest';

import { requireSameOrigin } from '~/lib/http';

function post(headers: Record<string, string>) {
  return new Request('https://labels.example/work/a1/draft', { method: 'POST', headers });
}

function refused(headers: Record<string, string>): number | null {
  try {
    requireSameOrigin(post(headers));
    return null;
  } catch (error) {
    return error instanceof Response ? error.status : -1;
  }
}

describe('requireSameOrigin', () => {
  it('lets the app itself through', () => {
    expect(refused({ Origin: 'https://labels.example' })).toBeNull();
    expect(refused({ Referer: 'https://labels.example/work/a1' })).toBeNull();
  });

  it('refuses another site, another port and another scheme', () => {
    expect(refused({ Origin: 'https://elsewhere.example' })).toBe(403);
    expect(refused({ Origin: 'https://labels.example:8443' })).toBe(403);
    expect(refused({ Origin: 'http://labels.example' })).toBe(403);
    expect(refused({ Origin: 'https://sub.labels.example' })).toBe(403);
  });

  it('goes by Origin when both headers are there', () => {
    expect(
      refused({ Origin: 'https://elsewhere.example', Referer: 'https://labels.example/' }),
    ).toBe(403);
  });

  it('falls back to Referer and refuses an opaque origin', () => {
    expect(refused({ Referer: 'https://elsewhere.example/page' })).toBe(403);
    expect(refused({ Origin: 'null' })).toBe(403);
    expect(refused({ Origin: 'not a url' })).toBe(403);
  });

  it('lets a request without either header through', () => {
    expect(refused({})).toBeNull();
  });
});
