import { toCsv } from '~/domain/csv';
import { requireUser } from '~/lib/auth.server';
import { requireProject } from '~/models/projects.server';
import { projectQuality } from '~/models/quality.server';

import type { Route } from './+types/project-quality-export';

/** The annotator table from the quality page as CSV. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'viewQuality');
  const { annotators } = await projectQuality(project);
  const csv = toCsv(
    [
      'annotator',
      'submitted',
      'skipped',
      'approval_rate',
      'sent_back',
      'avg_qa_score',
      'gold_attempts',
      'gold_accuracy',
      'avg_seconds',
      'tasks_per_hour',
      'flagged',
    ],
    annotators.map((a) => [
      a.name,
      a.submitted,
      a.skipped,
      a.approvalRate,
      a.sentBack,
      a.avgQaScore,
      a.goldAttempts,
      a.goldAccuracy,
      a.avgSeconds,
      a.tasksPerHour,
      a.flagged ? 'yes' : 'no',
    ]),
  );
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="annotator-quality.csv"',
    },
  });
}
