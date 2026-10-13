import { Link } from 'react-router';

import { CopyButton } from '~/components/copy-button';
import { LabelingInterface } from '~/components/labeling';
import { Badge, Card, EmptyState, PageHeader } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import type { Answer } from '~/domain/answers';
import { finalAnswer } from '~/domain/outcome';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { formatDateTime, REVIEW_BADGES, titleCase } from '~/lib/format';
import { forbidden, notFound } from '~/lib/http';
import { can } from '~/lib/permissions';
import { projectSchema, requireProject } from '~/models/projects.server';

import type { Route } from './+types/task-detail';

export function meta() {
  return [{ title: 'Task · Labeling Portal' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId);
  const role = current.membership.role;
  if (!can(role, 'manageProjects') && !can(role, 'review')) throw forbidden();

  const task = await prisma.task.findFirst({
    where: { id: params.taskId, projectId: project.id },
    include: {
      batch: { select: { id: true, name: true } },
      assignments: {
        orderBy: { claimedAt: 'asc' },
        include: {
          user: { select: { name: true } },
          reviews: {
            orderBy: { createdAt: 'asc' },
            include: { reviewer: { select: { name: true } } },
          },
        },
      },
    },
  });
  if (!task) throw notFound('Task not found');

  return {
    projectId: project.id,
    schema: projectSchema(project),
    task: {
      id: task.id,
      externalId: task.externalId,
      position: task.position,
      status: task.status,
      data: task.data as Record<string, unknown>,
      consensus: task.consensus as Answer | null,
      agreement: task.agreement,
      batch: task.batch,
    },
    assignments: task.assignments.map((a) => ({
      id: a.id,
      annotator: a.user.name,
      status: a.status,
      reviewStatus: a.reviewStatus,
      claimedAt: a.claimedAt,
      submittedAt: a.submittedAt,
      activeSeconds: a.activeSeconds,
      skipReason: a.skipReason,
      answer: a.answer ? finalAnswer<Answer>(a.answer, a.reviews) : null,
      corrected: a.reviews.some((r) => r.decision === 'FIX'),
      reviews: a.reviews.map((r) => ({
        id: r.id,
        reviewer: r.reviewer.name,
        decision: r.decision,
        qaScore: r.qaScore,
        feedback: r.feedback,
      })),
    })),
  };
}

export default function TaskDetail({ loaderData }: Route.ComponentProps) {
  const { projectId, schema, task, assignments } = loaderData;
  const submitted = assignments.filter((a) => a.answer);
  const other = assignments.filter((a) => !a.answer);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span>
            Task #{task.position}
            {task.externalId && (
              <span className="ml-2 font-mono text-base text-slate-400">{task.externalId}</span>
            )}
            <span className="ml-2 align-middle">
              <CopyButton value={task.externalId ?? task.id} label="Copy id" />
            </span>
          </span>
        }
        subtitle={
          <span>
            <Link
              to={`/projects/${projectId}/batches/${task.batch.id}`}
              className="text-indigo-700 hover:underline"
            >
              {task.batch.name}
            </Link>{' '}
            ·{' '}
            <Badge tone={task.status === 'COMPLETE' ? 'emerald' : 'slate'}>
              {titleCase(task.status)}
            </Badge>
            {task.agreement !== null && (
              <span> · agreement {Math.round(task.agreement * 100)}%</span>
            )}
          </span>
        }
      />

      {task.consensus && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Consensus
          </h2>
          <LabelingInterface
            schema={schema}
            data={task.data}
            value={task.consensus}
            onChange={() => {}}
            readOnly
          />
        </Card>
      )}

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Submissions
        </h2>
        {submitted.length === 0 && <EmptyState title="Nobody has submitted this task yet" />}
        {submitted.map((a) => {
          const badge = a.reviewStatus ? REVIEW_BADGES[a.reviewStatus] : null;
          return (
            <Card key={a.id}>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{a.annotator}</span>
                {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                {a.corrected && <Badge tone="sky">Showing reviewer correction</Badge>}
                <span className="text-slate-500">
                  {formatDuration(a.activeSeconds)} ·{' '}
                  {a.submittedAt ? formatDateTime(a.submittedAt) : ''}
                </span>
              </div>
              <LabelingInterface
                schema={schema}
                data={task.data}
                value={a.answer}
                onChange={() => {}}
                readOnly
              />
              {a.reviews.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm text-slate-600">
                  {a.reviews.map((r) => (
                    <li key={r.id}>
                      <span className="font-medium">{r.reviewer}</span>:{' '}
                      {r.decision.replace('_', ' ').toLowerCase()}
                      {r.qaScore !== null && ` (score ${r.qaScore})`}
                      {r.feedback && ` - ${r.feedback}`}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </section>

      {other.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Claims
          </h2>
          <ul className="space-y-1 text-sm">
            {other.map((a) => (
              <li key={a.id} className="text-slate-600">
                {a.annotator}: {titleCase(a.status)} · claimed {formatDateTime(a.claimedAt)}
                {a.skipReason && <span className="text-slate-500"> · “{a.skipReason}”</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="rounded-lg bg-white p-4 text-sm ring-1 ring-slate-200">
        <summary className="cursor-pointer font-medium">Raw task data</summary>
        <pre className="mt-2 overflow-x-auto text-xs">{JSON.stringify(task.data, null, 2)}</pre>
      </details>
    </div>
  );
}
