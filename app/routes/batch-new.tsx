import { data, Form, Link, useNavigation } from 'react-router';

import { Alert, Button, Card, Field, Input } from '~/components/ui';
import { detectFormat, parseImport, type ImportError } from '~/domain/import';
import { requiredFields } from '~/domain/task-schema';
import { requireUser } from '~/lib/auth.server';
import { redirectWithFlash } from '~/lib/flash.server';
import { logActivity } from '~/models/activity.server';
import { createBatch } from '~/models/batches.server';
import { projectSchema, requireProject } from '~/models/projects.server';

import type { Route } from './+types/batch-new';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

type ActionResult = { error?: string; errors?: ImportError[]; validRows?: number };

export function meta() {
  return [{ title: 'Import tasks · Labeling Portal' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  return { projectId: project.id, fields: requiredFields(projectSchema(project)) };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  if (project.status === 'ARCHIVED') {
    return data<ActionResult>(
      { error: 'Archived projects cannot take new tasks.' },
      { status: 400 },
    );
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return data<ActionResult>({ error: 'Choose a CSV or JSONL file to upload.' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return data<ActionResult>({ error: 'Files can be at most 5 MB.' }, { status: 400 });
  }

  const text = await file.text();
  const format = detectFormat(file.name, text);
  const result = parseImport(text, format, projectSchema(project));
  const skipInvalid = form.get('skipInvalid') === 'on';
  const qualification = form.get('qualification') === 'on';
  if (qualification) {
    for (const row of result.rows.filter((r) => r.gold === undefined)) {
      result.errors.push({
        line: row.line,
        message: 'Qualification questions need a _gold answer',
      });
    }
    result.rows = result.rows.filter((r) => r.gold !== undefined);
    result.errors.sort((a, b) => a.line - b.line);
  }

  if (result.rows.length === 0 || (result.errors.length > 0 && !skipInvalid)) {
    return data<ActionResult>(
      {
        error:
          result.rows.length === 0
            ? 'No valid tasks were found in the file.'
            : 'Some rows have problems. Fix them, or tick "skip invalid rows" to import the rest.',
        errors: result.errors.slice(0, 50),
        validRows: result.rows.length,
      },
      { status: 400 },
    );
  }

  const name = String(form.get('name') ?? '').trim() || file.name.replace(/\.[^.]+$/, '');
  const batch = await createBatch(project.id, { name, format, rows: result.rows, qualification });
  await logActivity({
    projectId: project.id,
    actorId: current.user.id,
    action: 'batch.imported',
    detail: { batchId: batch.id, name, tasks: result.rows.length, qualification },
  });
  const skipped = result.errors.length ? `, skipped ${result.errors.length} invalid rows` : '';
  return redirectWithFlash(
    request,
    `/projects/${project.id}/batches/${batch.id}`,
    `Imported ${result.rows.length} tasks${skipped}.`,
  );
}

export default function NewBatch({ loaderData, actionData }: Route.ComponentProps) {
  const { projectId, fields } = loaderData;
  const navigation = useNavigation();
  const result = actionData as ActionResult | undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Form method="post" encType="multipart/form-data" className="space-y-4 lg:col-span-2">
        {result?.error && <Alert>{result.error}</Alert>}
        {result?.errors && result.errors.length > 0 && (
          <div className="rounded-md bg-white p-4 text-sm ring-1 ring-rose-200">
            <p className="mb-2 font-medium text-rose-700">
              {result.errors.length} problem{result.errors.length === 1 ? '' : 's'}
              {result.validRows ? `, ${result.validRows} rows are fine` : ''}
            </p>
            <ul className="max-h-60 space-y-1 overflow-y-auto font-mono text-xs">
              {result.errors.map((e, i) => (
                <li key={i}>
                  {e.line > 0 && <span className="text-slate-400">line {e.line}: </span>}
                  {e.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field label="File" htmlFor="file" hint="CSV with a header row, or JSON Lines (.jsonl).">
          <input
            id="file"
            name="file"
            type="file"
            accept=".csv,.jsonl,.ndjson,text/csv,application/x-ndjson"
            className="block w-full text-sm"
            required
          />
        </Field>
        <Field label="Batch name" htmlFor="name" hint="Defaults to the file name.">
          <Input id="name" name="name" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" name="skipInvalid" />
          Skip invalid rows and import the rest
        </label>
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
