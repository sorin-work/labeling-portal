import type { Batch } from '@prisma/client';

import { readImportFile, type ImportError } from '~/domain/import';
import type { CurrentUser } from '~/lib/auth.server';
import { internalImageHosts } from '~/lib/env.server';

import { createBatch } from './batches.server';
import { projectSchema, requireProject } from './projects.server';

export const SCHEMA_CHANGED =
  'The project’s schema was changed while the file was being read. Nothing was imported. Upload the file again.';

export type ImportFileResult =
  | { ok: true; batch: Batch; tasks: number; repeated: boolean }
  | {
      ok: false;
      status: 400 | 409;
      error: string;
      errors?: ImportError[];
      /** problems beyond the listed ones */
      more?: number;
      unit?: 'line' | 'item';
      validRows?: number;
    };

/**
 * An upload of tasks, from the import page or the API: one check of who may
 * import (`requireProject` with `manageProjects`), the same reader, limits and
 * report, and `createBatch`, which writes the batch, its tasks and the audit
 * entry together or nothing. A file is imported completely or not at all.
 */
export async function importFile(
  current: CurrentUser,
  projectId: string,
  input: {
    bytes: Uint8Array;
    filename: string;
    name?: string;
    qualification?: boolean;
    idempotencyKey?: string | null;
    via?: 'page' | 'api';
  },
): Promise<ImportFileResult> {
  const project = await requireProject(current, projectId, 'manageProjects');
  if (project.status === 'ARCHIVED') {
    return { ok: false, status: 400, error: 'Archived projects cannot take new tasks.' };
  }
  const schema = projectSchema(project);
  const qualification = input.qualification ?? false;
  const outcome = readImportFile(input.bytes, input.filename, schema, {
    qualification,
    internalImageHosts: internalImageHosts(),
  });
  if (!outcome.ok) {
    return {
      ok: false,
      status: 400,
      error: outcome.message,
      errors: outcome.errors,
      more: outcome.more,
      unit: outcome.unit,
      validRows: outcome.validRows,
    };
  }
  const name = input.name?.trim() || input.filename.replace(/\.[^.]+$/, '') || 'Import';
  const created = await createBatch(project.id, {
    name,
    format: outcome.format,
    rows: outcome.rows,
    qualification,
    schema,
    actorId: current.user.id,
    idempotencyKey: input.idempotencyKey ?? null,
    via: input.via ?? 'page',
  });
  if (!created.ok) return { ok: false, status: 409, error: SCHEMA_CHANGED };
  return created;
}
