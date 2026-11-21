import type { ReviewStatus } from '@prisma/client';

import { isAccepted } from './outcome';

export type PayMode = 'PER_TASK' | 'HOURLY';

/**
 * One submission with the rate and pay mode that were frozen on it when it
 * was first submitted. Money is whole cents everywhere; nothing here holds a
 * fraction of a cent.
 */
export type PaidWork = {
  userId: string;
  name: string;
  email: string;
  projectId: string;
  projectName: string;
  payMode: PayMode;
  rateCents: number;
  activeSeconds: number;
  /**
   * a claim a manager released on an hourly project: its credited time is
   * paid, but it is not a task
   */
  released?: boolean;
};

/** A block of work that is paid as one: same person, project, pay mode and rate. */
export type ProjectPayout = {
  projectId: string;
  projectName: string;
  payMode: PayMode;
  rateCents: number;
  tasks: number;
  seconds: number;
  amountCents: number;
};

export type PayoutLine = {
  userId: string;
  name: string;
  email: string;
  tasks: number;
  seconds: number;
  amountCents: number;
  projects: ProjectPayout[];
};

/**
 * Divides two whole numbers, neither below zero, and rounds to the nearest
 * whole, a half going up. This is the only place an amount of money is
 * rounded. It works on the remainder, so no fraction is ever held in a float
 * on the way.
 */
export function divideRounded(numerator: number, denominator: number): number {
  const remainder = numerator % denominator;
  const whole = (numerator - remainder) / denominator;
  return remainder * 2 >= denominator ? whole + 1 : whole;
}

/**
 * What a block of work earns, in cents: the flat rate per task, or the hourly
 * rate for the total time. Hourly amounts are rounded once, to the nearest
 * cent, for the whole block rather than per task.
 */
export function amountCents(
  mode: PayMode,
  rateCents: number,
  tasks: number,
  seconds: number,
): number {
  if (mode === 'PER_TASK') return rateCents * tasks;
  return divideRounded(rateCents * seconds, 3600);
}

/**
 * The date a write gives the work when it leaves it with the review status
 * `status` at the moment `at`. Work is payable from the moment it is
 * accepted: a reviewer approved or fixed it, or it was submitted and needs no
 * review. That date is stored (`Assignment.payableAt`) and puts the work into
 * a pay period. Work that is waiting for review or was sent back has none.
 */
export function payableSince(status: ReviewStatus, at: Date): Date | null {
  return isAccepted(status) ? at : null;
}

/**
 * Groups work by person and then by project, pay mode and rate, and adds up
 * what each block earns. A project whose rate changed shows as two blocks,
 * one per rate, because each submission keeps the rate it was made under.
 */
export function computePayouts(work: PaidWork[]): { lines: PayoutLine[]; totalCents: number } {
  const lines = new Map<string, PayoutLine>();
  for (const item of work) {
    const line =
      lines.get(item.userId) ??
      ({
        userId: item.userId,
        name: item.name,
        email: item.email,
        tasks: 0,
        seconds: 0,
        amountCents: 0,
        projects: [],
      } satisfies PayoutLine);
    lines.set(item.userId, line);

    let block = line.projects.find(
      (p) =>
        p.projectId === item.projectId &&
        p.payMode === item.payMode &&
        p.rateCents === item.rateCents,
    );
    if (!block) {
      block = {
        projectId: item.projectId,
        projectName: item.projectName,
        payMode: item.payMode,
        rateCents: item.rateCents,
        tasks: 0,
        seconds: 0,
        amountCents: 0,
      };
      line.projects.push(block);
    }
    const tasks = item.released ? 0 : 1;
    block.tasks += tasks;
    block.seconds += item.activeSeconds;
    line.tasks += tasks;
    line.seconds += item.activeSeconds;
  }
  for (const line of lines.values()) {
    for (const p of line.projects)
      p.amountCents = amountCents(p.payMode, p.rateCents, p.tasks, p.seconds);
    line.amountCents = line.projects.reduce((s, p) => s + p.amountCents, 0);
  }
  const sorted = [...lines.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const line of sorted) {
    line.projects.sort(
      (a, b) =>
        a.projectName.localeCompare(b.projectName) ||
        a.projectId.localeCompare(b.projectId) ||
        a.payMode.localeCompare(b.payMode) ||
        a.rateCents - b.rateCents,
    );
  }
  return { lines: sorted, totalCents: sorted.reduce((s, l) => s + l.amountCents, 0) };
}

/** Cents as a plain decimal number for CSV files and form fields: 1250 is "12.50". */
export function centsToDecimal(cents: number): string {
  const abs = Math.abs(cents);
  const part = abs % 100;
  const whole = (abs - part) / 100;
  return `${cents < 0 ? '-' : ''}${whole}.${String(part).padStart(2, '0')}`;
}

/** Cents as US dollars for the pages: 123456 is "$1,234.56". */
export function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const part = abs % 100;
  const whole = (abs - part) / 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+$)/g, ',');
  return `${cents < 0 ? '-' : ''}$${grouped}.${String(part).padStart(2, '0')}`;
}

/** Parses "12.50" style money input into cents. */
export function parseMoney(input: string): number | null {
  const text = input.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
