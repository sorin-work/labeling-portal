import { Link } from 'react-router';

import { Badge, EmptyState } from '~/components/ui';
import { resolverRefusal } from '~/domain/disputes';
import { taskPreview } from '~/domain/preview';
import { requireUser } from '~/lib/auth.server';
import { DECISION_WORDS, DISPUTE_BADGES, formatDateTime } from '~/lib/format';
import { projectTitle } from '~/lib/meta';
import { listDisputes } from '~/models/disputes.server';
import { projectSchema, requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-disputes';

export function meta({ matches }: Route.MetaArgs) {
  return projectTitle(matches, 'Disputes');
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'review');
  const { open, settled } = await listDisputes(project.id);
  const schema = projectSchema(project);
  const row = (d: (typeof open)[number]) => ({
    id: d.id,
    status: d.status,
    annotator: d.openedBy.name,
    reviewer: d.review.reviewer.name,
    decision: d.review.decision,
    externalId: d.assignment.task.externalId,
    preview: taskPreview(schema, d.assignment.task.data, 60),
    reason: d.reason.length > 140 ? `${d.reason.slice(0, 139)}…` : d.reason,
    openedAt: d.createdAt,
    resolvedAt: d.resolvedAt,
    resolver: d.resolvedBy?.name ?? null,
    // the reviewer who decided and the annotator who did the work cannot settle it
    canResolve:
      d.status === 'OPEN' &&
      resolverRefusal({
        resolverId: current.user.id,
        reviewerId: d.review.reviewerId,
        annotatorId: d.assignment.userId,
      }) === null,
  });
  return { projectId: project.id, open: open.map(row), settled: settled.map(row) };
}

type Row = Route.ComponentProps['loaderData']['open'][number];

function DisputeList({ projectId, rows }: { projectId: string; rows: Row[] }) {
  return (
    <ul className="divide-y divide-slate-100 rounded-lg bg-white text-sm shadow-sm ring-1 ring-slate-200">
      {rows.map((d) => {
        const badge = DISPUTE_BADGES[d.status];
        return (
          <li key={d.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <Link
                to={`/projects/${projectId}/disputes/${d.id}`}
                className="block truncate hover:text-indigo-700"
              >
                {d.externalId && (
                  <span className="mr-2 font-mono text-xs text-slate-400">{d.externalId}</span>
                )}
                {d.preview}
              </Link>
              <div className="text-xs text-slate-500">
                {d.annotator} disputes work {DECISION_WORDS[d.decision]} by {d.reviewer}
              </div>
              <p className="mt-1 text-slate-600">{d.reason}</p>
            </div>
            <div className="flex flex-col items-end gap-1 text-xs text-slate-500">
              <Badge tone={badge.tone}>{badge.label}</Badge>
              <span>
                {d.resolvedAt
                  ? `${d.resolver ?? 'Someone'} · ${formatDateTime(d.resolvedAt)}`
                  : `Opened ${formatDateTime(d.openedAt)}`}
              </span>
              {d.status === 'OPEN' && !d.canResolve && <span>Someone else has to settle it</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function ProjectDisputes({ loaderData }: Route.ComponentProps) {
  const { projectId, open, settled } = loaderData;
  if (open.length === 0 && settled.length === 0) {
    return (
      <EmptyState title="No disputes">
        When an annotator disputes a review decision it shows up here.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Waiting for an outcome
        </h2>
        {open.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing is waiting.</p>
        ) : (
          <DisputeList projectId={projectId} rows={open} />
        )}
      </section>
      {settled.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Settled
          </h2>
          <DisputeList projectId={projectId} rows={settled} />
        </section>
      )}
    </div>
  );
}
