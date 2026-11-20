import { useState } from 'react';
import { Form } from 'react-router';

import { DEFAULT_DISPUTE_WINDOW_DAYS } from '~/domain/disputes';
import { renderMarkdown } from '~/domain/markdown';
import { MAX_GOLD_EVERY, MIN_GOLD_EVERY, QUEUE_ORDERS } from '~/domain/queue-order';
import { ALWAYS_REVIEW_FIRST } from '~/domain/review-sampling';
import {
  diffSchema,
  REDESIGN_HINT,
  type SchemaChange,
  type SchemaUsage,
} from '~/domain/schema-diff';
import {
  KIND_LABELS,
  parseTaskSchema,
  SCHEMA_TEMPLATES,
  type SchemaKind,
} from '~/domain/task-schema';

import { MarkdownBody } from './markdown';

import { Alert, Button, cx, Field, Input } from './ui';

export type ProjectFormDefaults = {
  name: string;
  description: string;
  instructions: string;
  schema: string;
  overlap: number;
  timeLimitMinutes: number;
  reviewRequired: boolean;
  reviewSamplePercent: number;
  disputeWindowDays: number;
  goldFeedback: boolean;
  queueOrder: 'IMPORT' | 'SHUFFLED';
  goldEvery: number | null;
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
  reviewSamplePercent: 100,
  disputeWindowDays: DEFAULT_DISPUTE_WINDOW_DAYS,
  goldFeedback: true,
  queueOrder: 'IMPORT',
  goldEvery: null,
  qualificationRequired: false,
  qualificationPassPercent: 80,
  payMode: 'PER_TASK',
  rate: '0.00',
};

const textareaClass =
  'block w-full rounded-md border-0 px-3 py-2 font-mono text-sm shadow-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-600';

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const CHANGE_STYLE: Record<SchemaChange['impact'], string> = {
  safe: 'text-slate-600',
  warning: 'text-amber-700',
  breaking: 'text-rose-600',
};

/** What the typed schema changes compared with the saved one, before the save. */
function SchemaChanges({ changes }: { changes: SchemaChange[] }) {
  if (changes.length === 0) return null;
  const blocked = changes.some((change) => change.impact === 'breaking');
  return (
    <div className="rounded-md p-3 text-xs ring-1 ring-slate-200" aria-live="polite">
      <p className={cx('font-medium', blocked ? 'text-rose-600' : 'text-slate-700')}>
        {blocked
          ? 'This edit cannot be saved because it would break work that already exists:'
          : 'Compared with the saved schema:'}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {changes.map((change) => (
          <li key={change.summary} className={CHANGE_STYLE[change.impact]}>
            {capitalize(change.reason || change.summary)}.
          </li>
        ))}
      </ul>
      {blocked && <p className="mt-1 text-slate-600">{REDESIGN_HINT}</p>}
    </div>
  );
}

export function ProjectForm({
  defaults,
  usage,
  errors,
  submitLabel,
  allowTemplates,
}: {
  defaults: ProjectFormDefaults;
  /** What stored work uses from the saved schema. Only an existing project has it. */
  usage?: SchemaUsage;
  errors?: Record<string, string>;
  submitLabel: string;
  allowTemplates: boolean;
}) {
  const [schema, setSchema] = useState(defaults.schema);
  const [instructions, setInstructions] = useState(defaults.instructions);
  const checked = parseTaskSchema(schema);
  const saved = usage ? parseTaskSchema(defaults.schema) : null;
  const changes =
    usage && saved?.ok && checked.ok ? diffSchema(saved.schema, checked.schema, usage) : [];

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
        <SchemaChanges changes={changes} />
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

      <div className="grid gap-4 sm:grid-cols-2">
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
      </div>

      <fieldset className="grid gap-4 rounded-md p-4 ring-1 ring-slate-200 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium text-slate-700">Review</legend>
        <label className="flex items-center gap-2 self-center text-sm text-slate-700">
          <input type="checkbox" name="reviewRequired" defaultChecked={defaults.reviewRequired} />
          Submissions are reviewed before they count
        </label>
        <Field
          label="Share to review (%)"
          htmlFor="reviewSamplePercent"
          error={errors?.reviewSamplePercent}
          hint={`100 reviews everything. Below that the rest is accepted unseen, except each annotator's first ${ALWAYS_REVIEW_FIRST} submissions and all work of annotators flagged for low gold accuracy.`}
        >
          <Input
            id="reviewSamplePercent"
            name="reviewSamplePercent"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={defaults.reviewSamplePercent}
          />
        </Field>
        <Field
          label="Dispute window (days)"
          htmlFor="disputeWindowDays"
          error={errors?.disputeWindowDays}
          hint="How long after a review the annotator can dispute it. 0 turns disputes off."
        >
          <Input
            id="disputeWindowDays"
            name="disputeWindowDays"
            type="number"
            min={0}
            max={90}
            required
            defaultValue={defaults.disputeWindowDays}
          />
        </Field>
        <label className="flex items-center gap-2 self-center text-sm text-slate-700">
          <input type="checkbox" name="goldFeedback" defaultChecked={defaults.goldFeedback} />
          After submitting a gold task, annotators see their score and the expected answer
        </label>
      </fieldset>

      <fieldset className="grid gap-4 rounded-md p-4 ring-1 ring-slate-200 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium text-slate-700">Queue</legend>
        <Field
          label="Task order inside a batch"
          htmlFor="queueOrder"
          error={errors?.queueOrder}
          hint="Batches are handed out by their priority, then in import order. Shuffled gives every annotator an order of their own, which stays the same for them."
        >
          <select
            id="queueOrder"
            name="queueOrder"
            defaultValue={defaults.queueOrder}
            className="block w-full rounded-md border-0 px-3 py-2 text-sm ring-1 ring-slate-300"
          >
            {(Object.keys(QUEUE_ORDERS) as Array<keyof typeof QUEUE_ORDERS>).map((order) => (
              <option key={order} value={order}>
                {QUEUE_ORDERS[order]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Gold spacing"
          htmlFor="goldEvery"
          error={errors?.goldEvery}
          hint="About one gold task in every this many tasks, at uneven intervals and never first in a session. Empty leaves gold tasks where their position puts them."
        >
          <Input
            id="goldEvery"
            name="goldEvery"
            type="number"
            min={MIN_GOLD_EVERY}
            max={MAX_GOLD_EVERY}
            placeholder="off"
            defaultValue={defaults.goldEvery ?? ''}
          />
        </Field>
      </fieldset>

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
