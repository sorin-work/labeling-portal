import type { Prisma } from '@prisma/client';
import { Link } from 'react-router';

import { Pagination } from '~/components/pagination';
import { Badge, Button, EmptyState, PageHeader } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import { shownReview } from '~/domain/disputes';
import { formatGoldScore, goldFeedback } from '~/domain/gold';
import { taskPreview } from '~/domain/preview';
import { assignmentRef } from '~/domain/reference';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { DISPUTE_BADGES, formatRelative, REVIEW_BADGES } from '~/lib/format';
import { paginate, readPage } from '~/lib/pagination';
import { projectSchema } from '~/models/projects.server';

import type { Route } from './+types/my-work';

export function meta() {
  return [{ title: 'My work · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await requireUser(request);
  const url = new URL(request.url);
  const returnedOnly = url.searchParams.get('filter') === 'returned';
  const where: Prisma.AssignmentWhereInput = {
    userId: user.id,
    status: 'SUBMITTED',
    ...(returnedOnly ? { reviewStatus: 'SENT_BACK' } : {}),
  };

  const [total, returned] = await Promise.all([
    prisma.assignment.count({ where }),
    prisma.assignment.count({
      where: { userId: user.id, status: 'SUBMITTED', reviewStatus: 'SENT_BACK' },
    }),
  ]);
  const page = paginate(total, readPage(url));
  const items = await prisma.assignment.findMany({
    where,
    orderBy: { submittedAt: 'desc' },
    skip: page.skip,
    take: page.take,
    include: {
      project: true,
      task: {
        select: {
          data: true,
          isGold: true,
          goldAnswer: true,
          goldRetiredAt: true,
        },
      },
      reviews: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { dispute: { select: { status: true, resolution: true } } },
      },
    },
  });

  return {
    returnedOnly,
    returned,
    page,
    items: items.map((a) => ({
      id: a.id,
      projectName: a.project.name,
      // the reference the work page showed; a task's own ids could mark it as gold
      ref: assignmentRef(a.id),
      preview: taskPreview(projectSchema(a.project), a.task.data, 70),
      submittedAt: a.submittedAt,
      activeSeconds: a.activeSeconds,
      reviewStatus: a.reviewStatus,
      takenBack: a.takenBackAt !== null && a.reviewStatus === 'SENT_BACK',
      // only the score, and only where the project shows gold feedback
      goldScore: goldFeedback(a, projectSchema(a.project))?.score ?? null,
      // feedback and score of an overturned decision give way to the dispute's outcome
      ...shownReview(a.reviews.at(0)),
    })),
  };
}

export default function MyWork({ loaderData }: Route.ComponentProps) {
  const { items, page, returned, returnedOnly } = loaderData;
  return (
    <div>
      <PageHeader
        title="My work"
        subtitle={
          returned > 0
            ? `${returned} submission${returned === 1 ? '' : 's'} came back with feedback.`
            : 'Everything you have submitted and what reviewers said.'
        }
        actions={
          <div className="flex gap-1">
            <Link
              to="?"
              className={
                !returnedOnly
                  ? 'rounded-md bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700'
                  : 'rounded-md px-3 py-1 text-sm text-slate-600'
              }
            >
              All
            </Link>
            <Link
              to="?filter=returned"
              className={
                returnedOnly
                  ? 'rounded-md bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700'
                  : 'rounded-md px-3 py-1 text-sm text-slate-600'
              }
            >
              Needs changes ({returned})
            </Link>
          </div>
        }
      />
      {items.length === 0 ? (
        <EmptyState title={returnedOnly ? 'Nothing needs changes' : 'No submissions yet'} />
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          {items.map((item) => {
            const badge = item.reviewStatus ? REVIEW_BADGES[item.reviewStatus] : null;
            const dispute = item.dispute && DISPUTE_BADGES[item.dispute.status];
            return (
              <li key={item.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-slate-500">
                    {item.projectName}
                    <span className="ml-2 font-mono">ref {item.ref}</span>
                  </div>
                  <div className="truncate">{item.preview}</div>
                  {item.feedback && (
                    <p className="mt-1 whitespace-pre-wrap rounded bg-amber-50 px-2 py-1 text-sm text-amber-900">
                      {item.feedback}
                    </p>
                  )}
                  {item.dispute?.resolution && (
                    <p className="mt-1 whitespace-pre-wrap rounded bg-slate-50 px-2 py-1 text-sm text-slate-700">
                      <span className="font-medium">{dispute?.label}:</span>{' '}
                      {item.dispute.resolution}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 text-xs text-slate-500">
                  {item.takenBack ? (
                    <Badge tone="sky">Taken back</Badge>
                  ) : (
                    badge && <Badge tone={badge.tone}>{badge.label}</Badge>
                  )}
                  {dispute && <Badge tone={dispute.tone}>{dispute.label}</Badge>}
                  {item.qaScore !== null && <span>Quality {item.qaScore}/5</span>}
                  {item.goldScore !== null && (
                    <Link to={`/my-work/${item.id}`} className="text-indigo-700 hover:underline">
                      Gold check {formatGoldScore(item.goldScore)}
                    </Link>
                  )}
                  <span>
                    {item.submittedAt ? formatRelative(item.submittedAt) : ''} ·{' '}
                    {formatDuration(item.activeSeconds)}
                  </span>
                  {item.reviewStatus === 'FIXED' && (
                    <Link to={`/my-work/${item.id}`} className="text-indigo-700 hover:underline">
                      See correction
                    </Link>
                  )}
                  {item.reviewStatus === 'SENT_BACK' &&
                    (item.dispute?.status === 'OPEN' ? (
                      <Link to={`/my-work/${item.id}`} className="text-indigo-700 hover:underline">
                        See dispute
                      </Link>
                    ) : (
                      <Link to={`/my-work/${item.id}`}>
                        <Button variant="secondary" className="mt-1">
                          Revise
                        </Button>
                      </Link>
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Pagination info={page} />
    </div>
  );
}
