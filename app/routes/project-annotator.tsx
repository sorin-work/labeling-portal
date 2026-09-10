import { Link } from 'react-router';

import { Badge, EmptyState, PageHeader } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import { taskPreview } from '~/domain/preview';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { formatDateTime, REVIEW_BADGES } from '~/lib/format';
import { notFound } from '~/lib/http';
import { projectSchema, requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-annotator';

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.annotator.name ?? 'Annotator'} · Labeling Portal` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'viewQuality');
  const annotator = await prisma.user.findFirst({
    where: { id: params.userId, memberships: { some: { orgId: project.orgId } } },
    select: { id: true, name: true, email: true },
  });
  if (!annotator) throw notFound('Annotator not found');

  const work = await prisma.assignment.findMany({
    where: {
      projectId: project.id,
      userId: annotator.id,
      status: { in: ['SUBMITTED', 'SKIPPED'] },
    },
    orderBy: { claimedAt: 'desc' },
    take: 50,
    include: {
      task: { select: { id: true, externalId: true, data: true, isGold: true } },
      reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  const schema = projectSchema(project);
  return {
    projectId: project.id,
    annotator,
    work: work.map((a) => ({
      id: a.id,
      taskId: a.task.id,
      externalId: a.task.externalId,
      preview: taskPreview(schema, a.task.data, 60),
      isGold: a.task.isGold,
      status: a.status,
      reviewStatus: a.reviewStatus,
      goldScore: a.goldScore,
      qaScore: a.reviews[0]?.qaScore ?? null,
      skipReason: a.skipReason,
      activeSeconds: a.activeSeconds,
      at: a.submittedAt ?? a.claimedAt,
    })),
  };
}

export default function ProjectAnnotator({ loaderData }: Route.ComponentProps) {
  const { projectId, annotator, work } = loaderData;
  return (
    <div>
      <PageHeader
        title={annotator.name}
        subtitle={
          <span>
            {annotator.email} ·{' '}
            <Link to={`/projects/${projectId}/quality`} className="text-indigo-700 hover:underline">
              back to quality
            </Link>
          </span>
        }
      />
      {work.length === 0 ? (
        <EmptyState title="No work in this project yet" />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg bg-white text-sm shadow-sm ring-1 ring-slate-200">
          {work.map((w) => {
            const badge = w.reviewStatus ? REVIEW_BADGES[w.reviewStatus] : null;
            return (
              <li key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                <Link
                  to={`/projects/${projectId}/tasks/${w.taskId}`}
                  className="min-w-0 flex-1 truncate hover:text-indigo-700"
                >
                  {w.externalId && (
                    <span className="mr-2 font-mono text-xs text-slate-400">{w.externalId}</span>
                  )}
                  {w.preview}
                </Link>
                {w.status === 'SKIPPED' ? (
                  <Badge tone="slate">Skipped: {w.skipReason}</Badge>
                ) : w.isGold ? (
                  <Badge tone={w.goldScore !== null && w.goldScore >= 0.8 ? 'emerald' : 'rose'}>
                    Gold {w.goldScore === null ? '–' : `${Math.round(w.goldScore * 100)}%`}
                  </Badge>
                ) : (
                  badge && <Badge tone={badge.tone}>{badge.label}</Badge>
                )}
                {w.qaScore !== null && (
                  <span className="text-xs text-slate-500">QA {w.qaScore}/5</span>
                )}
                <span className="w-40 text-right text-xs text-slate-500">
                  {formatDuration(w.activeSeconds)} · {formatDateTime(w.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
