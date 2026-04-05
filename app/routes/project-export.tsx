import { Button, Card } from '~/components/ui';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-export';

export function meta() {
  return [{ title: 'Export · Labeling Portal' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'exportLabels');
  const [complete, total] = await Promise.all([
    prisma.task.count({
      where: { projectId: project.id, status: 'COMPLETE', isGold: false, isQualification: false },
    }),
    prisma.task.count({ where: { projectId: project.id, isGold: false, isQualification: false } }),
  ]);
  return { projectId: project.id, kind: project.kind, complete, total };
}

export default function ProjectExport({ loaderData }: Route.ComponentProps) {
  const { projectId, kind, complete, total } = loaderData;
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
        <p className="text-xs text-slate-500">Gold and qualification tasks are never exported.</p>
        <Button type="submit">Download</Button>
      </form>
    </Card>
  );
}
