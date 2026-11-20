import { toCsvLine } from '~/domain/csv';
import { allActivity, readActivityFilter } from '~/models/activity.server';
import { auditLine, requireAuditor } from '~/models/audit.server';

import type { Route } from './+types/audit-export';

const AUDIT_COLUMNS = [
  'created_at',
  'actor',
  'actor_id',
  'action',
  'project',
  'project_id',
  'description',
  'detail',
];

/**
 * The audit trail with the filters of `/audit`, oldest first, as CSV. It is
 * written page by page as it is read. Cells are guarded against being run
 * as spreadsheet formulas, like every CSV of the app.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { membership } = await requireAuditor(request);
  const filter = readActivityFilter(new URL(request.url), membership.orgId);
  const encoder = new TextEncoder();
  const rows = allActivity(filter);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(toCsvLine(AUDIT_COLUMNS)));
    },
    async pull(controller) {
      try {
        const next = await rows.next();
        if (next.done) {
          controller.close();
          return;
        }
        const row = next.value;
        const line = auditLine(row);
        controller.enqueue(
          encoder.encode(
            toCsvLine([
              row.createdAt.toISOString(),
              row.actorName,
              row.actorId,
              row.action,
              line.project,
              row.projectId,
              line.text,
              row.detail === null ? '' : JSON.stringify(row.detail),
            ]),
          ),
        );
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await rows.return(undefined);
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="audit.csv"',
      'Cache-Control': 'no-store',
    },
  });
}
