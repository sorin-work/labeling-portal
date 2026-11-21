import { toCsv } from '~/domain/csv';
import { centsToDecimal } from '~/domain/payouts';
import { requireRole } from '~/lib/auth.server';
import { toDay } from '~/lib/dates';
import { prisma } from '~/lib/db.server';
import { notFound } from '~/lib/http';
import { logActivity } from '~/models/activity.server';
import { payRunWithLines } from '~/models/pay-runs.server';

import type { Route } from './+types/payouts-run-export';

/**
 * The CSV of a closed pay run, read from the lines copied when it was closed,
 * in the same columns as the live report. Nothing that happens later (a
 * renamed project, a removed person, work deleted with its batch) changes it.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { membership, user } = await requireRole(request, ['ADMIN', 'PROJECT_MANAGER']);
  const run = await payRunWithLines(membership.orgId, params.runId);
  if (!run) throw notFound('Pay run not found');
  const from = toDay(run.periodStart);
  const to = toDay(new Date(run.periodEnd.getTime() - 24 * 3600_000));
  await logActivity(prisma, {
    orgId: membership.orgId,
    actorId: user.id,
    action: 'export.payouts',
    detail: { from, to, runId: run.id },
  });
  const csv = toCsv(
    ['name', 'email', 'project', 'pay_mode', 'rate_usd', 'tasks', 'hours', 'amount_usd'],
    run.lines.map((line) => [
      line.name,
      line.email,
      line.projectName,
      line.payMode === 'HOURLY' ? 'hourly' : 'per task',
      centsToDecimal(line.rateCents),
      line.tasks,
      (line.seconds / 3600).toFixed(2),
      centsToDecimal(line.amountCents),
    ]),
  );
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="pay-run-${from}-to-${to}.csv"`,
    },
  });
}
