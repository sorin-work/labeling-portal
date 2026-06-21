import { NavLink, Outlet } from 'react-router';

import { Badge, cx } from '~/components/ui';
import { requireUser } from '~/lib/auth.server';
import { KIND_NAMES, STATUS_TONES, titleCase } from '~/lib/format';
import { can } from '~/lib/permissions';
import { requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-layout';

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId);
  const role = current.membership.role;
  return {
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      kind: project.kind,
    },
    can: {
      manage: can(role, 'manageProjects'),
      review: can(role, 'review'),
      quality: can(role, 'viewQuality'),
      export: can(role, 'exportLabels'),
    },
  };
}

export default function ProjectLayout({ loaderData }: Route.ComponentProps) {
  const { project, can } = loaderData;
  const base = `/projects/${project.id}`;
  const tabs = [
    { to: base, label: 'Overview', show: true },
    { to: `${base}/review`, label: 'Review', show: can.review },
    { to: `${base}/quality`, label: 'Quality', show: can.quality },
    { to: `${base}/batches`, label: 'Batches', show: can.manage },
    { to: `${base}/export`, label: 'Export', show: can.export },
    { to: `${base}/members`, label: 'Members', show: can.manage },
    { to: `${base}/activity`, label: 'Activity', show: can.manage },
    { to: `${base}/settings`, label: 'Settings', show: can.manage },
  ].filter((tab) => tab.show);

  return (
    <div>
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <Badge tone={STATUS_TONES[project.status]}>{titleCase(project.status)}</Badge>
          <Badge tone="indigo">{KIND_NAMES[project.kind]}</Badge>
        </div>
        <nav className="mt-4 flex gap-1 overflow-x-auto border-b border-slate-200">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === base}
              className={({ isActive }) =>
                cx(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
                  isActive
                    ? 'border-indigo-600 text-indigo-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800',
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet />
    </div>
  );
}
