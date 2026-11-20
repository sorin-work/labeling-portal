import { findExportFormat, type ExportContext } from '~/domain/export';
import { KIND_LABELS } from '~/domain/task-schema';
import { MAX_ZIP_ENTRIES } from '~/domain/zip';
import type { CurrentUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { badRequest } from '~/lib/http';

import { logActivity } from './activity.server';
import { countExportTasks, exportTasks } from './export.server';
import { projectSchema, requireProject } from './projects.server';

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'project'
  );
}

/** Sends the pieces a writer gives as they come, so nothing is held but the piece in hand. */
function stream(chunks: AsyncIterable<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else
          controller.enqueue(
            typeof next.value === 'string' ? encoder.encode(next.value) : next.value,
          );
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * The label export of one project, in any format of the table in
 * `domain/export.ts`. Only the project's own tasks are read: the project comes
 * from `requireProject`, which hides other organisations, and a `batch` from
 * another project matches nothing.
 */
/**
 * The label export of one project, in any format of the table in
 * `domain/export.ts`, for the download route and the API alike, with one
 * check of who may have it. Only the project's own tasks are read: the
 * project comes from `requireProject`, which hides other organisations, and a
 * `batch` from another project matches nothing. Takes `format`, `scope`,
 * `batch` and `annotators` from the address.
 */
export async function labelExport(
  current: CurrentUser,
  projectId: string,
  url: URL,
  via: 'page' | 'api' = 'page',
): Promise<Response> {
  const project = await requireProject(current, projectId, 'exportLabels');
  const format = findExportFormat(url.searchParams.get('format') ?? 'jsonl');
  if (!format) throw badRequest('Unknown export format');
  const schema = projectSchema(project);
  if (format.kinds && !format.kinds.includes(schema.kind)) {
    const kinds = format.kinds.map((kind) => KIND_LABELS[kind].toLowerCase()).join(' or ');
    throw badRequest(`${format.label} export is only available for ${kinds} projects`);
  }
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'complete';
  const batchId = url.searchParams.get('batch') || null;
  // pseudonyms unless the address is asked for: exports get passed around
  const annotators = url.searchParams.get('annotators') === 'email' ? 'email' : 'pseudonym';

  // a zip has room for 65,535 files, and two of them are not labels
  if (format.archive && (await countExportTasks(project, scope, batchId)) > MAX_ZIP_ENTRIES - 2) {
    throw badRequest(
      `A ${format.label} export holds at most ${MAX_ZIP_ENTRIES - 2} tasks. Export one batch at a time.`,
    );
  }

  // who took the labels, and in which form; recorded before the first byte goes out
  await logActivity(prisma, {
    orgId: project.orgId,
    projectId: project.id,
    actorId: current.user.id,
    action: 'export.labels',
    detail: {
      projectName: project.name,
      format: format.name,
      scope,
      batch: batchId,
      annotators,
      via,
    },
  });
  const context: ExportContext = { schema, projectName: project.name, now: new Date() };
  const tasks = exportTasks(project, { scope, batchId, annotators, needs: format.needs });
  return new Response(stream(format.write(context, tasks)), {
    headers: {
      'Content-Type': format.contentType,
      'Content-Disposition': `attachment; filename="${slug(project.name)}-${scope}.${format.extension}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
