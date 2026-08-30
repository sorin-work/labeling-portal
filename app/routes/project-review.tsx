import { Form, Link, redirect } from 'react-router';

import { Alert, Button, EmptyState } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import { taskPreview } from '~/domain/preview';
import { Pagination } from '~/components/pagination';
import { requireUser } from '~/lib/auth.server';
import { paginate, readPage } from '~/lib/pagination';
import { formatDateTime } from '~/lib/format';
import { projectSchema, requireProject } from '~/models/projects.server';
import { listPendingReviews, nextPendingReview, pendingByAnnotator } from '~/models/reviews.server';

import type { Route } from './+types/project-review';

export function meta() {
  return [{ title: 'Review · Labeling Portal' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'review');
  const url = new URL(request.url);

  if (url.searchParams.has('next')) {
    const next = await nextPendingReview(project.id, current.user.id);
    if (next) throw redirect(`/review/${next.id}`);
    throw redirect(`/projects/${project.id}/review?done=1`);
  }

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
    done: url.searchParams.has('done'),
    page,
    annotator,
    annotators,
    pending: pending.map((a) => ({
      id: a.id,
      annotator: a.user.name,
      submittedAt: a.submittedAt,
      activeSeconds: a.activeSeconds,
      externalId: a.task.externalId,
      preview: taskPreview(schema, a.task.data, 70),
    })),
  };
}

export default function ProjectReview({ loaderData }: Route.ComponentProps) {
  const { pending, done, annotator, annotators, page } = loaderData;
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
            <Link to="?next=1">
              <Button>Start reviewing</Button>
            </Link>
          </div>
          <table className="w-full overflow-hidden rounded-lg bg-white text-sm shadow-sm ring-1 ring-slate-200">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Task</th>
                <th className="px-4 py-2">Annotator</th>
                <th className="px-4 py-2">Time</th>
                <th className="px-4 py-2">Submitted</th>
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
                        <span className="mr-2 font-mono text-xs text-slate-400">
                          {item.externalId}
                        </span>
                      )}
                      {item.preview}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{item.annotator}</td>
                  <td className="px-4 py-2 text-slate-500">{formatDuration(item.activeSeconds)}</td>
                  <td className="px-4 py-2 text-slate-500">
                    {item.submittedAt ? formatDateTime(item.submittedAt) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination info={page} />
        </>
      )}
    </div>
  );
}
