import { Link } from 'react-router';

import { Button, EmptyState } from '~/components/ui';
import { requireUser } from '~/lib/auth.server';
import { formatDate } from '~/lib/format';
import { listBatches } from '~/models/batches.server';
import { requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-batches';

export function meta() {
  return [{ title: 'Batches · Labeling Portal' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  return { projectId: project.id, batches: await listBatches(project.id) };
}

export default function ProjectBatches({ loaderData }: Route.ComponentProps) {
  const { projectId, batches } = loaderData;
  const importButton = (
    <Link to={`/projects/${projectId}/batches/new`}>
      <Button>Import tasks</Button>
    </Link>
  );

  if (batches.length === 0) {
    return (
      <EmptyState title="No tasks imported yet" action={importButton}>
        Upload a CSV or JSONL file with one task per row.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">{importButton}</div>
      <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Batch</th>
              <th className="px-4 py-2">Format</th>
              <th className="px-4 py-2">Imported</th>
              <th className="px-4 py-2 text-right">Progress</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {batches.map((batch) => {
              const pct = batch.total ? Math.round((batch.complete / batch.total) * 100) : 0;
              return (
                <tr key={batch.id}>
                  <td className="px-4 py-3">
                    <Link
                      to={`/projects/${projectId}/batches/${batch.id}`}
                      className="font-medium text-indigo-700 hover:underline"
                    >
                      {batch.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{batch.format}</td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(batch.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded bg-slate-100">
                        <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-24 text-xs text-slate-500">
                        {batch.complete}/{batch.total} done
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
