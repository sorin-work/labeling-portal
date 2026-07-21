import { toCoco, toCsvExport, toJsonl } from '~/domain/export';
import { requireUser } from '~/lib/auth.server';
import { badRequest } from '~/lib/http';
import { loadExportTasks } from '~/models/export.server';
import { projectSchema, requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-download';

const FORMATS = {
  jsonl: { type: 'application/x-ndjson', ext: 'jsonl' },
  csv: { type: 'text/csv; charset=utf-8', ext: 'csv' },
  coco: { type: 'application/json', ext: 'coco.json' },
} as const;

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'project'
  );
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'exportLabels');
  const url = new URL(request.url);
  const format = url.searchParams.get('format') ?? 'jsonl';
  if (!(format in FORMATS)) throw badRequest('Unknown export format');
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'complete';
  const schema = projectSchema(project);
  if (format === 'coco' && schema.kind !== 'bbox') {
    throw badRequest('COCO export is only available for box projects');
  }

  const batchId = url.searchParams.get('batch') || null;
  const tasks = await loadExportTasks(project, scope, batchId);
  const body =
    format === 'jsonl'
      ? toJsonl(schema, tasks)
      : format === 'csv'
        ? toCsvExport(schema, tasks)
        : JSON.stringify(toCoco(schema, tasks, project.name), null, 2);
  const { type, ext } = FORMATS[format as keyof typeof FORMATS];

  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${slug(project.name)}-${scope}.${ext}"`,
    },
  });
}
