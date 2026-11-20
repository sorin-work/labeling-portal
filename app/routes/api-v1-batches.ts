import { MAX_IMPORT_BYTES } from '~/domain/import';
import { apiRoute } from '~/lib/api.server';
import { apiError } from '~/lib/auth.server';
import { readBoundedBody } from '~/lib/upload.server';
import { importFile } from '~/models/import.server';
import { requireProject } from '~/models/projects.server';

const MAX_KEY = 200;

/**
 * POST /api/v1/projects/:projectId/batches: the body is the file itself (CSV,
 * TSV, JSON Lines or a JSON array), read the same way as on the import page,
 * all or nothing, with the same limits and the same `{ line, message }`
 * problems. `?name=` names the batch and `?filename=` helps tell the format;
 * `?qualification=1` makes the rows qualification questions. With an
 * `Idempotency-Key` header, sending the same upload again answers with the
 * batch the first one made, and nothing is imported twice.
 */
export const action = apiRoute('write', async ({ request, params, current }) => {
  const projectId = params.projectId ?? '';
  // who may import is checked before the body is read
  await requireProject(current, projectId, 'manageProjects');
  const key = request.headers.get('Idempotency-Key');
  if (key !== null && (key.trim() === '' || key.length > MAX_KEY)) {
    return apiError(400, `Idempotency-Key must be 1 to ${MAX_KEY} characters.`);
  }
  const bytes = await readBoundedBody(request, MAX_IMPORT_BYTES);
  if (bytes === 'too_large') return apiError(413, 'Files can be at most 5 MB.');
  const url = new URL(request.url);
  const contentType = request.headers.get('Content-Type') ?? '';
  const filename =
    url.searchParams.get('filename') ||
    (contentType.includes('csv')
      ? 'upload.csv'
      : contentType.includes('tab-separated')
        ? 'upload.tsv'
        : contentType.includes('ndjson') || contentType.includes('jsonl')
          ? 'upload.jsonl'
          : contentType.includes('json')
            ? 'upload.json'
            : 'upload');
  const result = await importFile(current, projectId, {
    bytes,
    filename,
    name: url.searchParams.get('name') ?? '',
    qualification: url.searchParams.get('qualification') === '1',
    idempotencyKey: key,
    via: 'api',
  });
  if (!result.ok) {
    const { status, ...body } = result;
    return Response.json(
      {
        error: body.error,
        errors: body.errors ?? [],
        more: body.more ?? 0,
        unit: body.unit ?? 'line',
        validRows: body.validRows ?? 0,
      },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return Response.json(
    {
      batch: {
        id: result.batch.id,
        name: result.batch.name,
        format: result.batch.format,
        tasks: result.tasks,
        createdAt: result.batch.createdAt.toISOString(),
      },
      repeated: result.repeated,
    },
    { status: result.repeated ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
  );
});
