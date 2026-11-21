import { Prisma } from '@prisma/client';

import { closeRefusal, periodBounds, type CloseRefusal } from '~/domain/pay-runs';
import { computePayouts, type PaidWork } from '~/domain/payouts';
import { prisma, utc } from '~/lib/db.server';

import { logActivity } from './activity.server';
import type { PayoutRange } from './payouts.server';

/**
 * Closes a pay period of an organisation as paid: copies the payout report
 * of the period into a `PayRun` with its lines and marks every piece of work
 * in it with the run, in one transaction.
 *
 * Lock order (docs/architecture.md, "Pay runs"): the organisation's pay run
 * lock first (an advisory lock, exclusive here), then the assignment rows of
 * the period in id order. Closing locks no task row and no work clock, and
 * nothing that holds an assignment row of a closed-to-be period waits for the
 * pay run lock, so the two cannot wait for each other in a circle.
 *
 * The work is marked by the `UPDATE ... payRunId IS NULL` that also decides
 * what the lines hold: the lines are computed from exactly the rows marked,
 * so no work is in two runs and no run pays work it did not mark.
 */
export async function closePayRun(
  orgId: string,
  actorId: string,
  range: PayoutRange,
  note: string,
  now = new Date(),
): Promise<{ ok: true; runId: string; totalCents: number } | { ok: false; error: CloseRefusal }> {
  const period = periodBounds(range);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pay-run:${orgId}`}))`;
      const runs = await tx.payRun.findMany({
        where: { orgId },
        select: { periodStart: true, periodEnd: true },
      });
      const refused = closeRefusal(
        period,
        now,
        runs.map((r) => ({ start: r.periodStart, end: r.periodEnd })),
      );
      if (refused) return { ok: false, error: refused } as const;

      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT a.id FROM "Assignment" a
        JOIN "Project" p ON p.id = a."projectId"
        WHERE p."orgId" = ${orgId}
          AND a.status IN ('SUBMITTED', 'RELEASED')
          AND a."payRunId" IS NULL
          AND a."payableAt" >= ${utc(period.start)} AND a."payableAt" < ${utc(period.end)}
        ORDER BY a.id
        FOR UPDATE OF a`;
      const ids = locked.map((r) => r.id);
      const rows = await tx.assignment.findMany({
        where: { id: { in: ids } },
        select: {
          status: true,
          activeSeconds: true,
          rateCents: true,
          payMode: true,
          user: { select: { id: true, name: true, email: true } },
          project: { select: { id: true, name: true } },
        },
      });
      const work: PaidWork[] = rows.map((row) => {
        if (row.rateCents === null || row.payMode === null) {
          throw new Error('Payable work without a frozen rate');
        }
        return {
          userId: row.user.id,
          name: row.user.name,
          email: row.user.email,
          projectId: row.project.id,
          projectName: row.project.name,
          payMode: row.payMode,
          rateCents: row.rateCents,
          activeSeconds: row.activeSeconds,
          released: row.status === 'RELEASED',
        };
      });
      const { lines, totalCents } = computePayouts(work);
      const actor = await tx.user.findUniqueOrThrow({
        where: { id: actorId },
        select: { name: true },
      });
      const run = await tx.payRun.create({
        data: {
          orgId,
          periodStart: period.start,
          periodEnd: period.end,
          closedById: actorId,
          closedByName: actor.name,
          closedAt: now,
          totalCents,
          note,
          lines: {
            create: lines.flatMap((line) =>
              line.projects.map((block) => ({
                userId: line.userId,
                name: line.name,
                email: line.email,
                projectId: block.projectId,
                projectName: block.projectName,
                payMode: block.payMode,
                rateCents: block.rateCents,
                tasks: block.tasks,
                seconds: block.seconds,
                amountCents: block.amountCents,
              })),
            ),
          },
        },
      });
      if (ids.length > 0) {
        const marked = await tx.assignment.updateMany({
          where: { id: { in: ids }, payRunId: null },
          data: { payRunId: run.id },
        });
        // the rows are locked: nothing can have taken them in between
        if (marked.count !== ids.length) throw new Error('Pay run: work changed while closing');
      }
      await logActivity(tx, {
        orgId,
        actorId,
        action: 'payrun.closed',
        detail: {
          runId: run.id,
          from: range.from,
          to: range.to,
          totalCents,
          lines: lines.reduce((sum, line) => sum + line.projects.length, 0),
          people: lines.length,
        },
        createdAt: now,
      });
      return { ok: true, runId: run.id, totalCents } as const;
    },
    { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

/** The organisation's closed runs, the latest first. */
export function listPayRuns(orgId: string, take = 24) {
  return prisma.payRun.findMany({
    where: { orgId },
    orderBy: { periodStart: 'desc' },
    take,
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      closedByName: true,
      closedAt: true,
      totalCents: true,
      note: true,
      _count: { select: { lines: true } },
    },
  });
}

/** A closed run with its lines, as they were copied; null for another organisation's. */
export function payRunWithLines(orgId: string, runId: string) {
  return prisma.payRun.findFirst({
    where: { id: runId, orgId },
    include: {
      lines: { orderBy: [{ name: 'asc' }, { projectName: 'asc' }, { rateCents: 'asc' }] },
    },
  });
}
