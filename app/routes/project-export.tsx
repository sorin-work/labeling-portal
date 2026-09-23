import { Button, Card } from '~/components/ui';
import { requireUser } from '~/lib/auth.server';
import { projectTitle } from '~/lib/meta';
import { prisma } from '~/lib/db.server';
import { requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-export';

export function meta({ matches }: Route.MetaArgs) {
  return projectTitle(matches, 'Export');
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'exportLabels');
  const batches = await prisma.batch.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true },
  });
  const [complete, total] = await Promise.all([
    prisma.task.count({
      where: { projectId: project.id, status: 'COMPLETE', isGold: false, isQualification: false },
    }),
    prisma.task.count({ where: { projectId: project.id, isGold: false, isQualification: false } }),
  ]);
  return { projectId: project.id, kind: project.kind, complete, total, batches };
}

export default function ProjectExport({ loaderData }: Route.ComponentProps) {
  const { projectId, kind, complete, total, batches } = loaderData;
  const formats = [
    {
      value: 'jsonl',
      label: 'JSON Lines',
      hint: 'One task per line with every accepted annotation.',
    },
    { value: 'csv', label: 'CSV', hint: 'One row per annotation, plus a consensus row.' },
    ...(kind === 'BBOX'
      ? [
          {
            value: 'coco',
            label: 'COCO',
            hint: 'Object detection dataset from the consensus boxes.',
          },
        ]
      : []),
  ];
  return (
    <Card className="max-w-2xl">
      <form method="get" action={`/projects/${projectId}/download`} className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Format</legend>
          {formats.map((f, i) => (
            <label key={f.value} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="format"
                value={f.value}
                defaultChecked={i === 0}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{f.label}</span>
                <span className="block text-slate-500">{f.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Tasks</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="scope" value="complete" defaultChecked />
            Completed tasks only ({complete})
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="scope" value="all" />
            All tasks, including partly labeled ones ({total})
          </label>
        </fieldset>
        {batches.length > 1 && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Batch</span>
            <select
              name="batch"
              defaultValue=""
              className="rounded-md border-0 py-1.5 pl-2 pr-8 text-sm ring-1 ring-slate-300"
            >
              <option value="">All batches</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="text-xs text-slate-500">Gold and qualification tasks are never exported.</p>
        <Button type="submit">Download</Button>
      </form>
    </Card>
  );
}
