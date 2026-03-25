import { redirect } from 'react-router';

import { requireUser } from '~/lib/auth.server';
import { forbidden } from '~/lib/http';
import { can } from '~/lib/permissions';
import { requireProject } from '~/models/projects.server';
import { claimNextTask } from '~/models/queue.server';

import type { Route } from './+types/project-work';

/** POST: claim the next task (or resume the current one) and open it. */
export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  if (!can(current.membership.role, 'annotate')) throw forbidden();
  const project = await requireProject(current, params.projectId);
  const result = await claimNextTask(project, current.user.id);
  if (!result.ok) {
    if (result.reason === 'unqualified') return redirect(`/projects/${project.id}/qualification`);
    return redirect(`/projects/${project.id}?queue=${result.reason}`);
  }
  return redirect(`/work/${result.assignment.id}`);
}

export async function loader({ params }: Route.LoaderArgs) {
  return redirect(`/projects/${params.projectId}`);
}
