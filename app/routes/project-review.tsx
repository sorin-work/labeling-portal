import { Form, Link, redirect } from 'react-router';

import { Alert, Button, EmptyState } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import { taskPreview } from '~/domain/preview';
import { activeHold, REVIEW_HOLD_MINUTES } from '~/domain/review-hold';
import { Pagination } from '~/components/pagination';
import { requireUser } from '~/lib/auth.server';
import { projectTitle } from '~/lib/meta';
import { paginate, readPage } from '~/lib/pagination';
import { redirectWithFlash } from '~/lib/flash.server';
import { formatDateTime } from '~/lib/format';
import { can } from '~/lib/permissions';
import { projectSchema, requireProject } from '~/models/projects.server';
import {
  listPendingReviews,
  pendingByAnnotator,
  releaseReviewHold,
  reserveNextReview,
} from '~/models/reviews.server';

import type { Route } from './+types/project-review';

export function meta({ matches }: Route.MetaArgs) {
  return projectTitle(matches, 'Review');
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'review');
  const url = new URL(request.url);
  const now = new Date();

  const annotator = url.searchParams.get('annotator') ?? '';
  const annotators = await pendingByAnnotator(project.id);
  const total = annotators
    .filter((a) => !annotator || a.id === annotator)
    .reduce((s, a) => s + a.count, 0);
  const page = paginate(total, readPage(url));
  const pending = await listPendingReviews(project.id, {
    userId: annotator || undefined,
    skip: page.skip,
    take: page.take,
  });
  const schema = projectSchema(project);
  return {
    // managers can free a reservation a reviewer walked away from
    canRelease: can(current.membership.role, 'manageProjects'),
    done: url.searchParams.has('done'),
    page,
    annotator,
    annotators,
    pending: pending.map((a) => {
      const hold = activeHold(a, current.user.id, now);
      return {
        id: a.id,
        heldBy: hold ? (hold.mine ? 'You' : hold.reviewer) : null,
        // whose live hold a manager would release; the write checks it is still theirs
        holderId: hold && !hold.mine ? a.reviewHeldById : null,
        annotator: a.user.name,
        submittedAt: a.submittedAt,
        activeSeconds: a.activeSeconds,
        externalId: a.task.externalId,
        preview: taskPreview(schema, a.task.data, 70),
      };
    }),
  };
}

/**
 * POST: reserve the next submission for this reviewer and open it. Reserving
 * is a write, so "Start reviewing" posts here, like the claim in
 * `project-work.tsx`.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  const form = await request.formData();
  if (form.get('intent') === 'release-hold') {
    const project = await requireProject(current, params.projectId, 'manageProjects');
    const released = await releaseReviewHold(
      project,
      String(form.get('assignmentId') ?? ''),
      String(form.get('holderId') ?? ''),
      current.user.id,
    );
    return redirectWithFlash(
      request,
      `/projects/${project.id}/review`,
      released
        ? 'Released. Any reviewer can take that submission now.'
        : 'Nothing to release: that reviewer no longer holds the submission.',
    );
  }
  const project = await requireProject(current, params.projectId, 'review');
  const next = await reserveNextReview(project.id, current.user.id);
  return redirect(next ? `/review/${next.id}` : `/projects/${project.id}/review?done=1`);
}

export default function ProjectReview({ loaderData }: Route.ComponentProps) {
  const { pending, done, annotator, annotators, page, canRelease } = loaderData;
  return (
    <div className="space-y-4">
      {done && (
        <Alert tone="success">You are all caught up. Nothing else is waiting for you.</Alert>
      )}
      {annotators.length > 1 && (
        <Form
          className="flex items-center gap-2 text-sm"
          onChange={(e) => e.currentTarget.requestSubmit()}
        >
          <label htmlFor="annotator" className="text-slate-600">
            Annotator
          </label>
          <select
            id="annotator"
            name="annotator"
            defaultValue={annotator}
            className="rounded-md border-0 py-1.5 pl-2 pr-8 text-sm ring-1 ring-slate-300"
          >
            <option value="">Everyone</option>
            {annotators.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.count})
              </option>
            ))}
          </select>
          <noscript>
            <Button type="submit" variant="secondary">
              Filter
            </Button>
          </noscript>
        </Form>
      )}
      {pending.length === 0 ? (
        <EmptyState title="Nothing to review">New submissions will show up here.</EmptyState>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-600">
              {page.total} submission{page.total === 1 ? '' : 's'} waiting, oldest first.
            </p>
            <Form method="post">
              <Button
                title={`Reserves the next submission for you for ${REVIEW_HOLD_MINUTES} minutes`}
              >
                Start reviewing
              </Button>
            </Form>
          </div>
          <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Task</th>
                  <th className="px-4 py-2">Annotator</th>
                  <th className="px-4 py-2">Time</th>
                  <th className="px-4 py-2">Submitted</th>
                  <th className="px-4 py-2">Reviewer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pending.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="max-w-0 px-4 py-2">
                      <Link
                        to={`/review/${item.id}`}
                        className="block truncate hover:text-indigo-700"
                      >
                        {item.externalId && (
                          <span className="mr-2 font-mono text-xs text-slate-500">
                            {item.externalId}
                          </span>
                        )}
                        {item.preview}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{item.annotator}</td>
                    <td className="px-4 py-2 text-slate-500">
                      {formatDuration(item.activeSeconds)}
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {item.submittedAt ? formatDateTime(item.submittedAt) : ''}
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {item.heldBy ?? ''}
                      {canRelease && item.holderId && (
                        <Form method="post" className="ml-2 inline">
                          <input type="hidden" name="assignmentId" value={item.id} />
                          <input type="hidden" name="holderId" value={item.holderId} />
                          <Button
                            name="intent"
                            value="release-hold"
                            variant="secondary"
                            aria-label={`Release the reservation ${item.heldBy} has`}
                          >
                            Release
                          </Button>
                        </Form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination info={page} />
        </>
      )}
    </div>
  );
}
