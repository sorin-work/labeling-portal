import { useState } from 'react';
import { Form } from 'react-router';

import { KIND_LABELS, SCHEMA_TEMPLATES, type SchemaKind } from '~/domain/task-schema';

import { Alert, Button, Field, Input } from './ui';

export type ProjectFormDefaults = {
  name: string;
  description: string;
  instructions: string;
  schema: string;
  overlap: number;
  timeLimitMinutes: number;
  reviewRequired: boolean;
};

export const EMPTY_PROJECT: ProjectFormDefaults = {
  name: '',
  description: '',
  instructions: '',
  schema: JSON.stringify(SCHEMA_TEMPLATES.text_classification, null, 2),
  overlap: 1,
  timeLimitMinutes: 30,
  reviewRequired: true,
};

const textareaClass =
  'block w-full rounded-md border-0 px-3 py-2 font-mono text-sm shadow-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-600';

export function ProjectForm({
  defaults,
  errors,
  submitLabel,
  allowTemplates,
}: {
  defaults: ProjectFormDefaults;
  errors?: Record<string, string>;
  submitLabel: string;
  allowTemplates: boolean;
}) {
  const [schema, setSchema] = useState(defaults.schema);

  return (
    <Form method="post" className="space-y-6">
      {errors?._form && <Alert>{errors._form}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="name" error={errors?.name}>
          <Input id="name" name="name" defaultValue={defaults.name} required />
        </Field>
        <Field label="Short description" htmlFor="description" error={errors?.description}>
          <Input id="description" name="description" defaultValue={defaults.description} />
        </Field>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="schema" className="text-sm font-medium text-slate-700">
            Task schema (JSON)
          </label>
          {allowTemplates && (
            <div className="flex flex-wrap gap-1">
              {(Object.keys(SCHEMA_TEMPLATES) as SchemaKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setSchema(JSON.stringify(SCHEMA_TEMPLATES[kind], null, 2))}
                  className="rounded-md px-2 py-1 text-xs text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-50"
                >
                  {KIND_LABELS[kind]}
                </button>
              ))}
            </div>
          )}
        </div>
        <textarea
          id="schema"
          name="schema"
          rows={14}
          className={textareaClass}
          value={schema}
          onChange={(event) => setSchema(event.target.value)}
          spellCheck={false}
        />
        {errors?.schema && (
          <p className="text-xs text-rose-600" role="alert">
            {errors.schema}
          </p>
        )}
      </div>

      <Field
        label="Instructions for annotators"
        htmlFor="instructions"
        error={errors?.instructions}
        hint="Markdown is supported: headings, lists, links, emphasis and code."
      >
        <textarea
          id="instructions"
          name="instructions"
          rows={10}
          className={textareaClass}
          defaultValue={defaults.instructions}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Annotators per task"
          htmlFor="overlap"
          error={errors?.overlap}
          hint="How many people label each task independently."
        >
          <Input
            id="overlap"
            name="overlap"
            type="number"
            min={1}
            max={10}
            defaultValue={defaults.overlap}
          />
        </Field>
        <Field
          label="Time limit (minutes)"
          htmlFor="timeLimitMinutes"
          error={errors?.timeLimitMinutes}
          hint="Claims older than this go back to the queue."
        >
          <Input
            id="timeLimitMinutes"
            name="timeLimitMinutes"
            type="number"
            min={1}
            max={480}
            defaultValue={defaults.timeLimitMinutes}
          />
        </Field>
        <label className="flex items-center gap-2 self-center pt-4 text-sm text-slate-700">
          <input type="checkbox" name="reviewRequired" defaultChecked={defaults.reviewRequired} />
          Every submission needs review
        </label>
      </div>

      <div className="flex justify-end">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </Form>
  );
}
