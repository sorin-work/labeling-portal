import { toCsv } from '~/domain/csv';
import { centsToDecimal } from '~/domain/payouts';
import { requireRole } from '~/lib/auth.server';
import { readRange } from '~/lib/dates';
import { prisma } from '~/lib/db.server';
import { logActivity } from '~/models/activity.server';
import { payoutReport } from '~/models/payouts.server';

import type { Route } from './+types/payouts-export';

/**
 * CSV with one row per annotator, project and rate, ready for a payroll
 * import. A project whose rate changed within the range has one row per rate.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { membership, user } = await requireRole(request, ['ADMIN', 'PROJECT_MANAGER']);
  const range = readRange(new URL(request.url));
  const projectId = new URL(request.url).searchParams.get('project') || null;
  const { lines } = await payoutReport(membership.orgId, range, projectId);
  // a project of another organisation is not linked: the report showed none of it
  const project = projectId
    ? await prisma.project.findFirst({
        where: { id: projectId, orgId: membership.orgId },
        select: { id: true, name: true },
      })
    : null;
  await logActivity(prisma, {
    orgId: membership.orgId,
    projectId: project?.id ?? null,
    actorId: user.id,
    action: 'export.payouts',
    detail: { from: range.from, to: range.to, ...(project ? { projectName: project.name } : {}) },
  });

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
