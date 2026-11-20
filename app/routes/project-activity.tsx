import { EmptyState } from '~/components/ui';
import { describeSchemaChange } from '~/domain/schema-diff';
import { requireUser } from '~/lib/auth.server';
import { projectTitle } from '~/lib/meta';
import { prisma } from '~/lib/db.server';
import { formatDateTime } from '~/lib/format';
import { listActivity } from '~/models/activity.server';
import { requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-activity';

export function meta({ matches }: Route.MetaArgs) {
  return projectTitle(matches, 'Activity');
}

type Detail = Record<string, unknown> | null;

function describe(action: string, detail: Detail, names: Map<string, string>): string {
  const d = detail ?? {};
  switch (action) {
    case 'project.settings': {
      // `changes` maps a field to [before, after]; the schema pair is diffed
      // again here instead of storing the list of changes
      const changes = (d.changes ?? {}) as Record<string, unknown>;
      const schema = describeSchemaChange(changes.schema);
      return schema.length
        ? `changed the task schema: ${schema.join(', ')}`
        : 'updated the project settings';
    }
    case 'project.status':
      return `changed the status from ${String(d.from).toLowerCase()} to ${String(d.to).toLowerCase()}`;
    case 'project.duplicated':
      return 'made a copy of this project';
    case 'batch.imported':
      return `imported ${d.tasks} tasks as “${d.name}”${d.qualification ? ' (qualification test)' : ''}`;
    case 'batch.deleted':
      return `deleted a batch of ${d.tasks} tasks`;
    case 'batch.priority':
      return `set the priority of “${d.name}” to ${d.to} (it was ${d.from})`;
    case 'batch.paused':
      return `paused “${d.name}”: nothing from it is handed out`;
    case 'batch.resumed':
      return `resumed “${d.name}”`;
    case 'task.adjudicated':
      return `settled task #${d.position} in adjudication (${
        d.how === 'own'
          ? 'with an answer of their own'
          : d.how === 'consensus'
            ? 'kept the consensus'
            : 'used one of the answers'
      })`;
    case 'task.escalated':
      return `sent task #${d.position} to adjudication without waiting for an extra annotator`;
    case 'member.added':
      return `added ${names.get(String(d.userId)) ?? 'someone'} to the project`;
    case 'member.removed':
      return `removed ${names.get(String(d.userId)) ?? 'someone'} from the project`;
    case 'gold.created':
      return `made ${d.tasks} gold task${d.tasks === 1 ? '' : 's'} from completed tasks`;
    case 'gold.edited':
      return `changed the expected answer of gold task #${d.position} from “${d.from}” to “${d.to}”: ${d.reason}`;
    case 'gold.retired':
      return `retired gold task #${d.position}: ${d.reason}`;
    case 'gold.restored':
      return `brought gold task #${d.position} back: ${d.reason}`;
    case 'gold.rescored': {
      const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
      const flags = [
        count(d.newlyFlagged) ? `${count(d.newlyFlagged)} newly flagged` : '',
        count(d.noLongerFlagged) ? `${count(d.noLongerFlagged)} no longer flagged` : '',
      ].filter(Boolean);
      return `rescored gold task #${d.position}: ${d.scores} score${d.scores === 1 ? '' : 's'} changed for ${d.annotators} annotator${d.annotators === 1 ? '' : 's'}${flags.length ? ` (${flags.join(', ')})` : ''}`;
    }
    default:
      return action;
  }
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  const entries = await listActivity(project.id);
  const userIds = entries
    .map((e) => (e.detail as Detail)?.userId)
    .filter((id): id is string => typeof id === 'string');
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true },
  });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return {
    entries: entries.map((e) => ({
      id: e.id,
      actor: e.actor.name,
      text: describe(e.action, e.detail as Detail, names),
      createdAt: e.createdAt,
    })),
  };
}

export default function ProjectActivity({ loaderData }: Route.ComponentProps) {
  const { entries } = loaderData;
  if (entries.length === 0) return <EmptyState title="No activity yet" />;
  return (
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
  );
}
