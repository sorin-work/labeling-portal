import { Link } from 'react-router';

import { Badge, EmptyState } from '~/components/ui';
import { taskPreview } from '~/domain/preview';
import { requireUser } from '~/lib/auth.server';
import { formatDateTime } from '~/lib/format';
import { projectTitle } from '~/lib/meta';
import { listAdjudication } from '~/models/adjudication.server';
import { projectSchema, requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-adjudication';

export function meta({ matches }: Route.MetaArgs) {
  return projectTitle(matches, 'Adjudication');
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'review');
  const schema = projectSchema(project);
  const tasks = await listAdjudication(project.id, current.user.id);
  return {
    projectId: project.id,
    threshold: project.agreementThreshold,
    tasks: tasks.map(({ data, ...task }) => ({ ...task, preview: taskPreview(schema, data, 80) })),
  };
}

export default function ProjectAdjudication({ loaderData }: Route.ComponentProps) {
  const { projectId, tasks, threshold } = loaderData;
  if (tasks.length === 0) {
    return (
      <EmptyState title="Nothing to adjudicate">
        {threshold === null
          ? 'The agreement threshold is off for this project, so no task comes here.'
          : `A task whose accepted answers agree less than ${Math.round(threshold * 100)}% after its extra annotators shows up here.`}
      </EmptyState>
    );
  }
  return (
    <section>
      <p className="mb-3 text-sm text-slate-600">
        The longest waiting first. Open a task to settle it: use one of the answers, keep the
        consensus when a majority made one, or give an answer of your own. Nobody settles a task
        they labeled.
      </p>
      <ul className="divide-y divide-slate-100 rounded-lg bg-white text-sm shadow-sm ring-1 ring-slate-200">
        {tasks.map((task) => (
          <li key={task.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <Link
                to={`/projects/${projectId}/tasks/${task.id}`}
                className="block truncate hover:text-indigo-700"
              >
                <span className="mr-2 text-slate-400">#{task.position}</span>
                {task.externalId && (
                  <span className="mr-2 font-mono text-xs text-slate-400">{task.externalId}</span>
                )}
                {task.preview}
              </Link>
              <div className="text-xs text-slate-500">
                {task.batch} · {task.answers} answers
                {task.extraSlots > 0 && `, ${task.extraSlots} of them extra`}
                {task.agreement !== null && ` · agreement ${Math.round(task.agreement * 100)}%`}
                {task.hasConsensus ? ' · has a majority' : ' · no majority'}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 text-xs text-slate-500">
              {task.ownWork && <Badge tone="slate">You labeled it</Badge>}
              {task.escalatedAt && <span>Waiting since {formatDateTime(task.escalatedAt)}</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
