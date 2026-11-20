import { apiRoute } from '~/lib/api.server';
import { labelExport } from '~/models/label-export.server';

/**
 * GET /api/v1/projects/:projectId/export: the same file as the download on
 * the export page, with the same `format`, `scope`, `batch` and `annotators`.
 */
export const loader = apiRoute('read', ({ current, params, request }) =>
  labelExport(current, params.projectId ?? '', new URL(request.url), 'api'),
);
