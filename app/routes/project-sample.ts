import { sampleFile } from '~/domain/template';
import { requireUser } from '~/lib/auth.server';
import { projectSchema, requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-sample';

/** An example import file matching the project's schema. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  const format = new URL(request.url).searchParams.get('format') === 'jsonl' ? 'jsonl' : 'csv';
  return new Response(sampleFile(projectSchema(project), format), {
    headers: {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="example.${format}"`,
    },
  });
}
