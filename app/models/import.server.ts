import { createHash } from 'node:crypto';

import type { Batch } from '@prisma/client';

import { readImportFile, type ImportError } from '~/domain/import';
import type { CurrentUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { internalImageHosts } from '~/lib/env.server';

import { createBatch, earlierBatch, type CreateBatchResult } from './batches.server';
import { wakeJobs } from '~/lib/jobs.server';
import { projectSchema, requireProject } from './projects.server';

export const SCHEMA_CHANGED =
  'The project’s schema was changed while the file was being read. Nothing was imported. Upload the file again.';

export type ImportFileResult =
  | { ok: true; batch: Batch; tasks: number; repeated: boolean }
  | {
      ok: false;
      status: 400 | 409 | 422;
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
  const key = input.idempotencyKey ?? null;
  const hash = key ? createHash('sha256').update(input.bytes).digest('hex') : null;
  // a repeat is answered before the file is read again
  if (key) {
    const earlier = await earlierBatch(prisma, project.id, key, hash);
    if (earlier) return settled(earlier);
  }
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
    idempotencyKey: key,
    idempotencyHash: hash,
    via: input.via ?? 'page',
  });
  // the project's rule runs after this request has been answered, as a job
  // that createBatch added with the batch
  if (created.ok && !created.repeated && created.batch.prelabelState === 'PENDING') wakeJobs();
  return settled(created);
}

function settled(result: CreateBatchResult): ImportFileResult {
  if (result.ok) return result;
  if (result.error === 'key_reused') {
    return {
      ok: false,
      status: 422,
      error: 'This Idempotency-Key was used for another file. Use a new key for a new file.',
    };
  }
  return { ok: false, status: 409, error: SCHEMA_CHANGED };
}
