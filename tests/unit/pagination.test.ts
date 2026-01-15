import { describe, expect, it } from 'vitest';

import { paginate, readPage } from '~/lib/pagination';

describe('readPage', () => {
  it('reads positive integers', () => {
    expect(readPage(new URL('http://x/?page=3'))).toBe(3);
  });

  it('falls back to the first page', () => {
    expect(readPage(new URL('http://x/'))).toBe(1);
    expect(readPage(new URL('http://x/?page=-2'))).toBe(1);
    expect(readPage(new URL('http://x/?page=abc'))).toBe(1);
    expect(readPage(new URL('http://x/?page=1.5'))).toBe(1);
  });
});

describe('paginate', () => {
  it('computes the slice for a page', () => {
    expect(paginate(100, 2, 25)).toMatchObject({ page: 2, pageCount: 4, skip: 25, take: 25 });
  });

  it('clamps pages past the end', () => {
    expect(paginate(50, 9, 25)).toMatchObject({ page: 2, skip: 25 });
  });

  it('has one page when there is nothing to show', () => {
    expect(paginate(0, 1)).toMatchObject({ page: 1, pageCount: 1, skip: 0 });
  });
});
