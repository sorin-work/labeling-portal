import { Link } from 'react-router';

import { Badge, Button, EmptyState, PageHeader } from '~/components/ui';
import { requireUser } from '~/lib/auth.server';
import { formatDate, KIND_NAMES, STATUS_TONES, titleCase } from '~/lib/format';
import { can } from '~/lib/permissions';
import { listProjects } from '~/models/projects.server';

import type { Route } from './+types/projects';

export function meta() {
  return [{ title: 'Projects · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const all = await listProjects(current);
  const showArchived = new URL(request.url).searchParams.get('archived') === '1';
  const archived = all.filter((p) => p.status === 'ARCHIVED').length;
  return {
    projects: showArchived ? all : all.filter((p) => p.status !== 'ARCHIVED'),
    archived,
    showArchived,
    canManage: can(current.membership.role, 'manageProjects'),
  };
}

export default function Projects({ loaderData }: Route.ComponentProps) {
  const { projects, canManage, archived, showArchived } = loaderData;
  const newButton = canManage ? (
    <Link to="/projects/new">
      <Button>New project</Button>
    </Link>
  ) : null;

  return (
    <div>
      <PageHeader title="Projects" actions={newButton} />
      {archived > 0 && (
        <div className="mb-3 text-right text-sm">
          <Link
            to={showArchived ? '/projects' : '/projects?archived=1'}
            className="text-slate-500 hover:text-slate-800"
          >
            {showArchived ? 'Hide archived projects' : `Show ${archived} archived`}
          </Link>
        </div>
      )}
      {projects.length === 0 ? (
        <EmptyState title="No projects yet" action={newButton}>
          {canManage
            ? 'Create a project to start importing tasks.'
            : 'You have not been added to any project. Ask a project manager to add you.'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                to={`/projects/${project.id}`}
                className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{project.name}</span>
                    <Badge tone={STATUS_TONES[project.status]}>{titleCase(project.status)}</Badge>
                  </div>
                  <div className="mt-0.5 truncate text-sm text-slate-500">
                    {project.description || KIND_NAMES[project.kind]}
                  </div>
                </div>
                <div className="hidden text-right text-xs text-slate-500 sm:block">
                  <div>{KIND_NAMES[project.kind]}</div>
                  <div>
                    {project._count.members} members · created {formatDate(project.createdAt)}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
