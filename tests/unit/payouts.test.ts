import { describe, expect, it } from 'vitest';

import {
  computePayouts,
  formatCents,
  parseMoney,
  taskAmountCents,
  type PaidWork,
} from '~/domain/payouts';

const work = (overrides: Partial<PaidWork>): PaidWork => ({
  userId: 'u1',
  name: 'Ann',
  email: 'ann@example.test',
  projectId: 'p1',
  projectName: 'Sentiment',
  payMode: 'PER_TASK',
  rateCents: 25,
  activeSeconds: 60,
  ...overrides,
});

describe('taskAmountCents', () => {
  it('pays the flat rate per task', () => {
    expect(taskAmountCents('PER_TASK', 40, 9999)).toBe(40);
  });

  it('pays hourly work by the second', () => {
    expect(taskAmountCents('HOURLY', 1800, 3600)).toBe(1800);
    expect(taskAmountCents('HOURLY', 1800, 1800)).toBe(900);
  });
});

describe('computePayouts', () => {
  it('groups by person and project', () => {
    const { lines, totalCents } = computePayouts([
      work({}),
      work({}),
      work({
        projectId: 'p2',
        projectName: 'Boxes',
        payMode: 'HOURLY',
        rateCents: 1200,
        activeSeconds: 1800,
      }),
      work({ userId: 'u2', name: 'Ben', email: 'ben@example.test' }),
    ]);
    expect(lines.map((l) => [l.name, l.tasks, l.amountCents])).toEqual([
      ['Ann', 3, 650],
      ['Ben', 1, 25],
    ]);
    expect(lines[0].projects.map((p) => p.projectName)).toEqual(['Boxes', 'Sentiment']);
    expect(totalCents).toBe(675);
  });

  it('returns nothing for no work', () => {
    expect(computePayouts([])).toEqual({ lines: [], totalCents: 0 });
  });
});

describe('money helpers', () => {
  it('formats cents', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
  });

  it('parses money input', () => {
    expect(parseMoney('12.5')).toBe(1250);
    expect(parseMoney('$0.07')).toBe(7);
    expect(parseMoney('3')).toBe(300);
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });
});
