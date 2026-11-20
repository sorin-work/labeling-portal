import { describe, expect, it } from 'vitest';

import {
  amountCents,
  centsToDecimal,
  computePayouts,
  divideRounded,
  formatCents,
  parseMoney,
  payableSince,
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

describe('divideRounded', () => {
  it('rounds to the nearest whole, a half going up', () => {
    expect(divideRounded(0, 3600)).toBe(0);
    expect(divideRounded(7200, 3600)).toBe(2);
    expect(divideRounded(1799, 3600)).toBe(0);
    expect(divideRounded(1800, 3600)).toBe(1);
    expect(divideRounded(5399, 3600)).toBe(1);
    expect(divideRounded(5400, 3600)).toBe(2);
  });

  it('stays exact where a float would not', () => {
    // 0.1 + 0.2 style traps: these are whole cents all the way
    expect(divideRounded(1005, 10)).toBe(101);
    expect(divideRounded(35, 10)).toBe(4);
    // a year of hourly work at $95.37/h, to the cent
    expect(divideRounded(9537 * 7_488_000, 3600)).toBe(19_836_960);
    expect(Number.isInteger(divideRounded(9537 * 7_488_001, 3600))).toBe(true);
  });
});

describe('amountCents', () => {
  it('pays the flat rate per task', () => {
    expect(amountCents('PER_TASK', 40, 3, 9999)).toBe(120);
  });

  it('pays hourly work by the second', () => {
    expect(amountCents('HOURLY', 1800, 1, 3600)).toBe(1800);
    expect(amountCents('HOURLY', 1800, 2, 1800)).toBe(900);
  });

  it('rounds an hourly amount to the nearest cent, half a cent going up', () => {
    // $18/h is half a cent per second
    expect(amountCents('HOURLY', 1800, 1, 60)).toBe(30);
    expect(amountCents('HOURLY', 1800, 1, 61)).toBe(31);
    expect(amountCents('HOURLY', 1800, 1, 1)).toBe(1);
    // $17/h for 7 seconds is 3.3 cents
    expect(amountCents('HOURLY', 1700, 1, 7)).toBe(3);
    expect(amountCents('HOURLY', 0, 4, 9000)).toBe(0);
  });
});

describe('payableSince', () => {
  const at = new Date('2026-04-02T09:00:00Z');

  it('dates work that a write accepts', () => {
    // a reviewer approved or fixed it, or it was submitted and needs no review
    expect(payableSince('APPROVED', at)).toBe(at);
    expect(payableSince('FIXED', at)).toBe(at);
    expect(payableSince('NOT_REQUIRED', at)).toBe(at);
  });

  it('gives no date to work that waits for review or was sent back', () => {
    expect(payableSince('PENDING', at)).toBeNull();
    expect(payableSince('SENT_BACK', at)).toBeNull();
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

  it('rounds hourly pay once for all tasks of a project', () => {
    // 3 x 61s at $18/h = 183s = 91.5 cents; per-task flooring gave 90
    const { lines } = computePayouts(
      [1, 2, 3].map(() => work({ payMode: 'HOURLY', rateCents: 1800, activeSeconds: 61 })),
    );
    expect(lines[0].amountCents).toBe(92);
  });

  it('keeps work under different rates of one project apart', () => {
    // the project paid 25 cents a task, then 40
    const { lines, totalCents } = computePayouts([
      work({ rateCents: 40 }),
      work({ rateCents: 25 }),
      work({ rateCents: 25 }),
      work({ rateCents: 40 }),
      work({ rateCents: 40 }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].projects.map((p) => [p.rateCents, p.tasks, p.amountCents])).toEqual([
      [25, 2, 50],
      [40, 3, 120],
    ]);
    expect(lines[0]).toMatchObject({ tasks: 5, amountCents: 170 });
    expect(totalCents).toBe(170);
  });

  it('keeps per-task and hourly work of one project apart', () => {
    const { lines } = computePayouts([
      work({ payMode: 'HOURLY', rateCents: 1800, activeSeconds: 600 }),
      work({ payMode: 'PER_TASK', rateCents: 1800 }),
    ]);
    expect(lines[0].projects.map((p) => [p.payMode, p.amountCents])).toEqual([
      ['HOURLY', 300],
      ['PER_TASK', 1800],
    ]);
  });

  it('rounds each block once, so a rate change can move the total by a cent', () => {
    const hourly = (rateCents: number) => work({ payMode: 'HOURLY', rateCents, activeSeconds: 61 });
    // one block: 2 x 61s at $18/h is exactly 61 cents
    expect(computePayouts([hourly(1800), hourly(1800)]).totalCents).toBe(61);
    // two blocks: 30.5 and 31.52 cents, each rounded by itself, make 63 and not 62
    const { lines, totalCents } = computePayouts([hourly(1800), hourly(1860)]);
    expect(lines[0].projects.map((p) => p.amountCents)).toEqual([31, 32]);
    expect(lines[0].amountCents).toBe(63);
    expect(totalCents).toBe(63);
  });

  it('adds whole cents only', () => {
    const { lines, totalCents } = computePayouts(
      Array.from({ length: 1000 }, (_, i) =>
        work({
          userId: `u${i % 7}`,
          name: `P${i % 7}`,
          payMode: 'HOURLY',
          rateCents: 1799 + (i % 3),
          activeSeconds: 37 + i,
        }),
      ),
    );
    expect(lines.every((l) => Number.isInteger(l.amountCents))).toBe(true);
    expect(lines.flatMap((l) => l.projects).every((p) => Number.isInteger(p.amountCents))).toBe(
      true,
    );
    expect(totalCents).toBe(lines.reduce((sum, l) => sum + l.amountCents, 0));
  });

  it('returns nothing for no work', () => {
    expect(computePayouts([])).toEqual({ lines: [], totalCents: 0 });
  });
});

describe('money helpers', () => {
  it('formats cents', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(100)).toBe('$1.00');
    expect(formatCents(99999)).toBe('$999.99');
    expect(formatCents(100000000)).toBe('$1,000,000.00');
    expect(formatCents(-150)).toBe('-$1.50');
  });

  it('writes cents as a decimal number without going through a float', () => {
    expect(centsToDecimal(0)).toBe('0.00');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(35)).toBe('0.35');
    expect(centsToDecimal(1250)).toBe('12.50');
    expect(centsToDecimal(100000)).toBe('1000.00');
    expect(centsToDecimal(-5)).toBe('-0.05');
    // every amount survives the trip through the settings form
    for (const cents of [1, 7, 10, 29, 57, 110, 1005, 1999, 123457]) {
      expect(parseMoney(centsToDecimal(cents))).toBe(cents);
    }
  });

  it('parses money input', () => {
    expect(parseMoney('12.5')).toBe(1250);
    expect(parseMoney('$0.07')).toBe(7);
    expect(parseMoney('3')).toBe(300);
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });
});
