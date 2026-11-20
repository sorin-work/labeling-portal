import { data, Form, Link, useNavigation } from 'react-router';

import { Alert, Button, Card, Field, Input } from '~/components/ui';
import { MAX_IMPORT_BYTES, readImportFile, type ImportError } from '~/domain/import';
import { requiredFields } from '~/domain/task-schema';
import { requireUser } from '~/lib/auth.server';
import { internalImageHosts } from '~/lib/env.server';
import { redirectWithFlash } from '~/lib/flash.server';
import { readBoundedForm } from '~/lib/upload.server';
import { createBatch } from '~/models/batches.server';
import { projectSchema, requireProject } from '~/models/projects.server';

import type { Route } from './+types/batch-new';

/** Room for the form's other fields and the multipart framing around the file. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

type ActionResult = {
  error?: string;
  errors?: ImportError[];
  /** problems beyond the listed ones */
  more?: number;
  unit?: 'line' | 'item';
  validRows?: number;
};

export function meta() {
  return [{ title: 'Import tasks · Labeling Portal' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  return { projectId: project.id, fields: requiredFields(projectSchema(project)) };
}

/**
 * Wires the upload to the reader in `domain/import.ts` and stores what it
 * returns. A file is imported completely or not at all.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  if (project.status === 'ARCHIVED') {
    return data<ActionResult>(
      { error: 'Archived projects cannot take new tasks.' },
      { status: 400 },
    );
  }

  const form = await readBoundedForm(request, MAX_IMPORT_BYTES + FORM_OVERHEAD_BYTES);
  if (form === 'too_large') {
    return data<ActionResult>({ error: 'Files can be at most 5 MB.' }, { status: 413 });
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return data<ActionResult>(
      { error: 'Choose a CSV, TSV, JSON or JSON Lines file to upload.' },
      { status: 400 },
    );
  }

  const schema = projectSchema(project);
  const qualification = form.get('qualification') === 'on';
  const outcome = readImportFile(new Uint8Array(await file.arrayBuffer()), file.name, schema, {
    qualification,
    internalImageHosts: internalImageHosts(),
  });
  if (!outcome.ok) {
    return data<ActionResult>(
      {
        error: outcome.message,
        errors: outcome.errors,
        more: outcome.more,
        unit: outcome.unit,
        validRows: outcome.validRows,
      },
      { status: 400 },
    );
  }

  const name = String(form.get('name') ?? '').trim() || file.name.replace(/\.[^.]+$/, '');
  const created = await createBatch(project.id, {
    name,
    format: outcome.format,
    rows: outcome.rows,
    qualification,
    schema,
    actorId: current.user.id,
  });
  if (!created.ok) {
    return data<ActionResult>(
      {
        error:
          'The project\u2019s schema was changed while the file was being read. Nothing was imported. Upload the file again.',
      },
      { status: 409 },
    );
  }
  return redirectWithFlash(
    request,
    `/projects/${project.id}/batches/${created.batch.id}`,
    `Imported ${outcome.rows.length} tasks.`,
  );
}

export default function NewBatch({ loaderData, actionData }: Route.ComponentProps) {
  const { projectId, fields } = loaderData;
  const navigation = useNavigation();
  const result = actionData as ActionResult | undefined;
  const more = result?.more ?? 0;
  const problems = (result?.errors?.length ?? 0) + more;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Form method="post" encType="multipart/form-data" className="space-y-4 lg:col-span-2">
        {result?.error && <Alert>{result.error}</Alert>}
        {result?.errors && result.errors.length > 0 && (
          <div className="rounded-md bg-white p-4 text-sm ring-1 ring-rose-200">
            <p className="mb-2 font-medium text-rose-700">
              {problems} problem{problems === 1 ? '' : 's'}
              {result.validRows
                ? `, ${result.validRows === 1 ? '1 row is' : `${result.validRows} rows are`} fine`
                : ''}
            </p>
            <ul className="max-h-60 space-y-1 overflow-y-auto font-mono text-xs">
              {result.errors.map((e, i) => (
                <li key={i}>
                  {e.line > 0 && (
                    <span className="text-slate-400">
                      {result.unit ?? 'line'} {e.line}:{' '}
                    </span>
                  )}
                  {e.message}
                </li>
              ))}
              {more > 0 && <li className="text-slate-500">and {more} more</li>}
            </ul>
          </div>
        )}
        <Field
          label="File"
          htmlFor="file"
          hint="CSV or TSV with a header row, JSON Lines (.jsonl), or a JSON array (.json). Up to 5,000 rows and 5 MB."
        >
          <input
            id="file"
            name="file"
            type="file"
            accept=".csv,.tsv,.jsonl,.ndjson,.json,text/csv,text/tab-separated-values,application/json,application/x-ndjson"
            className="block w-full text-sm"
            required
          />
        </Field>
        <Field label="Batch name" htmlFor="name" hint="Defaults to the file name.">
          <Input id="name" name="name" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" name="qualification" />
          This batch is the qualification test (every row needs a <code>_gold</code> answer)
        </label>
        <div className="flex gap-2">
          <Button type="submit" disabled={navigation.state === 'submitting'}>
            {navigation.state === 'submitting' ? 'Importing…' : 'Import'}
          </Button>
          <Link to={`/projects/${projectId}/batches`}>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </Link>
        </div>
      </Form>
      <Card className="h-fit text-sm text-slate-600">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          File format
        </h2>
        <p>Every row needs these fields:</p>
        <ul className="my-2 list-disc pl-5 font-mono text-xs">
          {fields.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <p>
          An optional <code className="font-mono">id</code> column is kept as the task&apos;s
          external id and included in exports. Other columns are stored with the task.
        </p>
        <p className="mt-2">
          Add a <code className="font-mono">_gold</code> column with the correct answer to make a
          row a gold task.
        </p>
        <p className="mt-2">
          A file is imported completely or not at all. One row with a problem stops the import, and
          the problems are listed with their lines.
        </p>
        <p className="mt-2">
          A JSON Lines or CSV export of this portal can be imported too: each task comes back with
          its data, and its consensus answer as the gold answer.
        </p>
        <p className="mt-3 flex gap-3">
          <a
            href={`/projects/${projectId}/example?format=csv`}
            className="text-indigo-700 hover:underline"
          >
            Example CSV
          </a>
          <a
            href={`/projects/${projectId}/example?format=jsonl`}
            className="text-indigo-700 hover:underline"
          >
            Example JSONL
          </a>
        </p>
      </Card>
    </div>
  );
}
