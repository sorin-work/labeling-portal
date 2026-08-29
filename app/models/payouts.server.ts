import { ACCEPTED_STATUSES } from '~/domain/outcome';
import { computePayouts, type PaidWork } from '~/domain/payouts';
import { prisma } from '~/lib/db.server';

export type PayoutRange = { from: string; to: string };

/**
 * Accepted work submitted within the range (both days inclusive, UTC) across
 * all of the organisation's projects, grouped per annotator.
 */
export async function payoutReport(orgId: string, range: PayoutRange, projectId?: string | null) {
  const from = new Date(`${range.from}T00:00:00Z`);
  // the last day counts in full: stop at midnight after it
  const end = new Date(`${range.to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);

  const rows = await prisma.assignment.findMany({
    where: {
      project: { orgId },
      ...(projectId ? { projectId } : {}),
      status: 'SUBMITTED',
      reviewStatus: { in: [...ACCEPTED_STATUSES] },
      submittedAt: { gte: from, lt: end },
    },
    select: {
      activeSeconds: true,
      user: { select: { id: true, name: true, email: true } },
      project: { select: { id: true, name: true, payMode: true, rateCents: true } },
    },
  });

  const work: PaidWork[] = rows.map((row) => ({
    userId: row.user.id,
    name: row.user.name,
    email: row.user.email,
    projectId: row.project.id,
    projectName: row.project.name,
    payMode: row.project.payMode,
    rateCents: row.project.rateCents,
    activeSeconds: row.activeSeconds,
  }));
  const pending = await prisma.assignment.count({
    where: {
      project: { orgId },
      ...(projectId ? { projectId } : {}),
      status: 'SUBMITTED',
      reviewStatus: { in: ['PENDING', 'SENT_BACK'] },
      submittedAt: { gte: from, lt: end },
    },
  });

  return { ...computePayouts(work), pending };
}
