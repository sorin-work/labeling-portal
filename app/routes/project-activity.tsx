import { Pagination } from '~/components/pagination';
import { EmptyState } from '~/components/ui';
import { describeActivity } from '~/domain/activity';
import { requireUser } from '~/lib/auth.server';
import { formatDateTime } from '~/lib/format';
import { projectTitle } from '~/lib/meta';
import { paginate, readPage } from '~/lib/pagination';
import { countActivity, listActivity } from '~/models/activity.server';
import { requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-activity';

export function meta({ matches }: Route.MetaArgs) {
  return projectTitle(matches, 'Activity');
}

/** The audit trail of one project, newest first, in pages. Managers of the project only. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  const filter = { orgId: project.orgId, projectId: project.id };
  const page = paginate(await countActivity(filter), readPage(new URL(request.url)));
  const entries = await listActivity(filter, page);
  return {
    page,
    entries: entries.map((e) => ({
      id: e.id,
      actor: e.actorName,
      text: describeActivity(e.action, e.detail),
      createdAt: e.createdAt,
    })),
  };
}

export default function ProjectActivity({ loaderData }: Route.ComponentProps) {
  const { entries, page } = loaderData;
  if (entries.length === 0) return <EmptyState title="No activity yet" />;
  return (
    <div>
      <ul className="divide-y divide-slate-100 rounded-lg bg-white text-sm shadow-sm ring-1 ring-slate-200">
        {entries.map((e) => (
          <li key={e.id} className="flex flex-wrap justify-between gap-2 px-4 py-2.5">
            <span>
              <span className="font-medium">{e.actor}</span> {e.text}
            </span>
            <span className="text-xs text-slate-500">{formatDateTime(e.createdAt)}</span>
          </li>
        ))}
      </ul>
      <Pagination info={page} />
    </div>
  );
}
