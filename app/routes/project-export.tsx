import { Link } from 'react-router';

import { Button, Card } from '~/components/ui';
import { conllBlock, exportFormatsFor } from '~/domain/export';
import { requireUser } from '~/lib/auth.server';
import { projectTitle } from '~/lib/meta';
import { prisma } from '~/lib/db.server';
import { exportTasks } from '~/models/export.server';
import { projectSchema, requireProject } from '~/models/projects.server';

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
  const schema = projectSchema(project);
  // Spans are character offsets and need not end where a token ends. The
  // CoNLL export widens such spans to whole tokens; this counts them, when
  // asked, by doing what the export does without writing it.
  let alignment: { spans: number; misaligned: number } | null = null;
  if (schema.kind === 'ner' && new URL(request.url).searchParams.get('check') === 'conll') {
    alignment = { spans: 0, misaligned: 0 };
    const tasks = exportTasks(project, { scope: 'all', annotators: 'pseudonym', needs: 'labels' });
    for await (const task of tasks) {
      const block = conllBlock(schema, task);
      alignment.spans += block?.spans ?? 0;
      alignment.misaligned += block?.misaligned ?? 0;
    }
  }
  return {
    projectId: project.id,
    // the component only gets what it shows; the writers stay on the server
    formats: exportFormatsFor(schema.kind).map(({ name, label, hint }) => ({ name, label, hint })),
    entities: schema.kind === 'ner',
    alignment,
    complete,
    total,
    batches,
  };
}

export default function ProjectExport({ loaderData }: Route.ComponentProps) {
  const { projectId, formats, entities, alignment, complete, total, batches } = loaderData;
  return (
    <Card className="max-w-2xl">
      <form method="get" action={`/projects/${projectId}/download`} className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Format</legend>
          {formats.map((f, i) => (
            <label key={f.name} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="format"
                value={f.name}
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
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Annotators</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="annotators"
              value="pseudonym"
              defaultChecked
              className="mt-1"
            />
            <span>
              <span className="font-medium">Pseudonyms</span>
              <span className="block text-slate-500">
                A name like ann_3f9a1c2e that is the same in every export of this project and says
                nothing about the person.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="annotators" value="email" className="mt-1" />
            <span>
              <span className="font-medium">Email addresses</span>
              <span className="block text-slate-500">
                Only for files that stay with people who may see who did the work.
              </span>
            </span>
          </label>
        </fieldset>
        <p className="text-xs text-slate-500">
          Gold and qualification tasks are never exported. Text files are UTF-8 and dates are ISO
          8601 in UTC.
        </p>
        <Button type="submit">Download</Button>
      </form>
      {entities && (
        <div className="mt-5 border-t border-slate-100 pt-4 text-sm text-slate-600">
          <p>
            The CoNLL export tags whole tokens. A span that ends inside a word is widened to the
            whole word.
          </p>
          {alignment ? (
            <p className="mt-1 font-medium text-slate-800">
              {alignment.misaligned} of {alignment.spans} labeled spans do not line up with tokens.
            </p>
          ) : (
            <Link to="?check=conll" className="mt-1 inline-block text-indigo-700 hover:underline">
              Count the spans that do not line up
            </Link>
          )}
        </div>
      )}
    </Card>
  );
}
