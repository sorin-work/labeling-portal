import { useState } from 'react';
import { Form } from 'react-router';

import { MAX_ADJUDICATION_NOTE } from '~/domain/adjudication';
import type { Answer } from '~/domain/answers';
import type { TaskSchema } from '~/domain/task-schema';

import { LabelingInterface } from './labeling';
import { Button, Card, Input } from './ui';

export type AdjudicationView = {
  threshold: number | null;
  extraSlots: number;
  /** accepted submissions the adjudicator can pick from */
  choices: Array<{ assignmentId: string; annotator: string }>;
  hasConsensus: boolean;
  /** null when this user may settle it; otherwise why not */
  refusal: string | null;
};

/** The adjudicator's decision on a task whose answers agreed too little. */
export function AdjudicationPanel({
  schema,
  data,
  view,
  busy,
}: {
  schema: TaskSchema;
  data: Record<string, unknown>;
  view: AdjudicationView;
  busy: boolean;
}) {
  const first = view.hasConsensus ? 'consensus' : (view.choices[0]?.assignmentId ?? 'own');
  const [choice, setChoice] = useState<string>(first);
  const [own, setOwn] = useState<Answer | null>(null);
  const kind = choice === 'consensus' ? 'consensus' : choice === 'own' ? 'own' : 'submission';

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Adjudication
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          The accepted answers agree less than the project asks for
          {view.threshold !== null && ` (${Math.round(view.threshold * 100)}%)`}
          {view.extraSlots > 0 &&
            `, also with ${view.extraSlots} extra annotator${view.extraSlots === 1 ? '' : 's'}`}
          . The answer chosen here becomes the result of the task in the consensus and the export.
          The submissions, their reviews and their pay stay as they are.
        </p>
      </div>
      {view.refusal ? (
        <p className="text-sm text-slate-500">{view.refusal}</p>
      ) : (
        <Form method="post" className="space-y-4">
          <fieldset className="space-y-2 text-sm">
            <legend className="sr-only">Settle the task with</legend>
            {view.hasConsensus && (
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="choice"
                  value="consensus"
                  checked={choice === 'consensus'}
                  onChange={() => setChoice('consensus')}
                />
                Keep the consensus (what the majority agreed on)
              </label>
            )}
            {view.choices.map((c) => (
              <label key={c.assignmentId} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="choice"
                  value={c.assignmentId}
                  checked={choice === c.assignmentId}
                  onChange={() => setChoice(c.assignmentId)}
                />
                Use the answer of {c.annotator}
              </label>
            ))}
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="choice"
                value="own"
                checked={choice === 'own'}
                onChange={() => setChoice('own')}
              />
              Give an answer of my own
            </label>
          </fieldset>
          {kind === 'own' && (
            <LabelingInterface schema={schema} data={data} value={own} onChange={setOwn} />
          )}
          <input type="hidden" name="kind" value={kind} />
          {kind === 'submission' && <input type="hidden" name="assignmentId" value={choice} />}
          {kind === 'own' && (
            <input type="hidden" name="answer" value={own ? JSON.stringify(own) : ''} />
          )}
          <label htmlFor="adjudication-note" className="block text-sm font-medium text-slate-700">
            Why
            <Input
              id="adjudication-note"
              name="note"
              required
              maxLength={MAX_ADJUDICATION_NOTE}
              className="mt-1 font-normal"
              placeholder="Kept with the task"
            />
          </label>
          <Button name="intent" value="adjudicate" disabled={busy}>
            Settle the task
          </Button>
        </Form>
      )}
    </Card>
  );
}
