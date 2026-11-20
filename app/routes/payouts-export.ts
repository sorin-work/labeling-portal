import { toCsv } from '~/domain/csv';
import { centsToDecimal } from '~/domain/payouts';
import { requireRole } from '~/lib/auth.server';
import { readRange } from '~/lib/dates';
import { payoutReport } from '~/models/payouts.server';

import type { Route } from './+types/payouts-export';

/**
 * CSV with one row per annotator, project and rate, ready for a payroll
 * import. A project whose rate changed within the range has one row per rate.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { membership } = await requireRole(request, ['ADMIN', 'PROJECT_MANAGER']);
  const range = readRange(new URL(request.url));
  const projectId = new URL(request.url).searchParams.get('project') || null;
  const { lines } = await payoutReport(membership.orgId, range, projectId);

  const rows = lines.flatMap((line) =>
    line.projects.map((p) => [
      line.name,
      line.email,
      p.projectName,
      p.payMode === 'HOURLY' ? 'hourly' : 'per task',
      centsToDecimal(p.rateCents),
      p.tasks,
      (p.seconds / 3600).toFixed(2),
      centsToDecimal(p.amountCents),
    ]),
  );
  const csv = toCsv(
    ['name', 'email', 'project', 'pay_mode', 'rate_usd', 'tasks', 'hours', 'amount_usd'],
    rows,
  );
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="payouts-${range.from}-to-${range.to}.csv"`,
    },
  });
}
