import { useState } from 'react';
import { Form } from 'react-router';

import { renderMarkdown } from '~/domain/markdown';
import {
  KIND_LABELS,
  parseTaskSchema,
  SCHEMA_TEMPLATES,
  type SchemaKind,
} from '~/domain/task-schema';

import { MarkdownBody } from './markdown';

import { Alert, Button, Field, Input } from './ui';

export type ProjectFormDefaults = {
  name: string;
  description: string;
  instructions: string;
  schema: string;
  overlap: number;
  timeLimitMinutes: number;
  reviewRequired: boolean;
  qualificationRequired: boolean;
  qualificationPassPercent: number;
  payMode: 'PER_TASK' | 'HOURLY';
  rate: string;
};

export const EMPTY_PROJECT: ProjectFormDefaults = {
  name: '',
  description: '',
  instructions: '',
  schema: JSON.stringify(SCHEMA_TEMPLATES.text_classification, null, 2),
  overlap: 1,
  timeLimitMinutes: 30,
  reviewRequired: true,
  qualificationRequired: false,
  qualificationPassPercent: 80,
  payMode: 'PER_TASK',
  rate: '0.00',
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
  const [instructions, setInstructions] = useState(defaults.instructions);
  const checked = parseTaskSchema(schema);

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
        {errors?.schema ? (
          <p className="text-xs text-rose-600" role="alert">
            {errors.schema}
          </p>
        ) : checked.ok ? (
          <p className="text-xs text-emerald-700">
            ✓ {KIND_LABELS[checked.schema.kind]} schema looks good.
          </p>
        ) : (
          <p className="text-xs text-amber-700">{checked.errors[0]}</p>
        )}
      </div>

      <Field
        label="Instructions for annotators"
        htmlFor="instructions"
        error={errors?.instructions}
        hint="Markdown is supported: headings, lists, links, emphasis and code."
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <textarea
            id="instructions"
            name="instructions"
            rows={14}
            className={textareaClass}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <div className="max-h-80 overflow-y-auto rounded-md bg-white p-3 ring-1 ring-slate-200">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Preview
            </div>
            {instructions.trim() ? (
              <MarkdownBody html={renderMarkdown(instructions)} />
            ) : (
              <p className="text-sm text-slate-400">Nothing to preview yet.</p>
            )}
          </div>
        </div>
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

      <fieldset className="grid gap-4 rounded-md p-4 ring-1 ring-slate-200 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium text-slate-700">Qualification</legend>
        <label className="flex items-center gap-2 self-center text-sm text-slate-700">
          <input
            type="checkbox"
            name="qualificationRequired"
            defaultChecked={defaults.qualificationRequired}
          />
          Annotators must pass a test before they can work
        </label>
        <Field
          label="Pass mark (%)"
          htmlFor="qualificationPassPercent"
          error={errors?.qualificationPassPercent}
          hint="Import test questions as a batch marked as a qualification test."
        >
          <Input
            id="qualificationPassPercent"
            name="qualificationPassPercent"
            type="number"
            min={1}
            max={100}
            defaultValue={defaults.qualificationPassPercent}
          />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 rounded-md p-4 ring-1 ring-slate-200 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium text-slate-700">Pay</legend>
        <Field label="Pay by" htmlFor="payMode">
          <select
            id="payMode"
            name="payMode"
            defaultValue={defaults.payMode}
            className="block w-full rounded-md border-0 px-3 py-2 text-sm ring-1 ring-slate-300"
          >
            <option value="PER_TASK">Accepted task</option>
            <option value="HOURLY">Hour of active work</option>
          </select>
        </Field>
        <Field label="Rate (USD)" htmlFor="rate" error={errors?.rate}>
          <Input id="rate" name="rate" inputMode="decimal" defaultValue={defaults.rate} />
        </Field>
      </fieldset>

      <div className="flex justify-end">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </Form>
  );
}
