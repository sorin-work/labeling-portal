import { useState } from 'react';
import { Form, Link } from 'react-router';

import type { Answer, Preference } from '~/domain/answers';
import { formatGoldScore, MAX_GOLD_REASON, type GoldImpact } from '~/domain/gold';
import type { TaskSchema } from '~/domain/task-schema';
import { formatDateTime } from '~/lib/format';

import { LabelingInterface } from './labeling';
import { Badge, Button, Card, Input } from './ui';

export type GoldPanelData = {
  isGold: boolean;
  isQualification: boolean;
  answer: Answer | null;
  retiredAt: Date | string | null;
  source: { id: string; position: number } | null;
  revisions: Array<{
    id: string;
    change: 'CREATED' | 'EDITED' | 'RETIRED' | 'RESTORED';
    by: string;
    at: Date | string;
    reason: string;
    from: string | null;
    to: string | null;
  }>;
  rescore: {
    submissions: number;
    changes: Array<{ userId: string }>;
    impact: GoldImpact;
    digest: string;
  } | null;
  retireImpact: GoldImpact | null;
  names: Record<string, string>;
};

const CHANGE_WORDS = {
  CREATED: 'made this a gold task',
  EDITED: 'changed the expected answer',
  RETIRED: 'retired the task',
  RESTORED: 'brought the task back',
};

function ReasonField({ id }: { id: string }) {
  return (
    <label htmlFor={id} className="block text-sm font-medium text-slate-700">
      Why
      <Input
        id={id}
        name="reason"
        required
        maxLength={MAX_GOLD_REASON}
        className="mt-1 font-normal"
        placeholder="Kept in the history of this task"
      />
    </label>
  );
}

/** Who moves and who crosses the flag, as a short list. */
function Impact({ impact, names }: { impact: GoldImpact; names: Record<string, string> }) {
  const name = (id: string) => names[id] ?? 'Someone';
  if (impact.moved.length === 0) {
    return <p className="text-slate-600">Nobody&apos;s gold accuracy changes.</p>;
  }
  return (
    <div className="space-y-1 text-slate-600">
      <p>
        Gold accuracy changes for {impact.moved.length} annotator
        {impact.moved.length === 1 ? '' : 's'}:
      </p>
      <ul className="list-inside list-disc">
        {impact.moved.map((m) => (
          <li key={m.userId}>
            {name(m.userId)}: {formatGoldScore(m.before.accuracy)} over {m.before.attempts} gold
            task{m.before.attempts === 1 ? '' : 's'} becomes {formatGoldScore(m.after.accuracy)}{' '}
            over {m.after.attempts}
          </li>
        ))}
      </ul>
      {impact.newlyFlagged.length > 0 && (
        <p className="font-medium text-rose-700">
          Becomes flagged for low gold accuracy: {impact.newlyFlagged.map(name).join(', ')}
        </p>
      )}
      {impact.noLongerFlagged.length > 0 && (
        <p className="font-medium text-emerald-700">
          No longer flagged: {impact.noLongerFlagged.map(name).join(', ')}
        </p>
      )}
    </div>
  );
}

const NO_CLAWBACK =
  'Only gold scores change. Work that was accepted stays accepted and paid, and nobody is asked to redo anything.';

/**
 * The manager's side of a gold task or qualification question on the task
 * page: the expected answer with its editor, rescoring, retiring and the
 * history of changes.
 */
export function GoldPanel({
  projectId,
  schema,
  data,
  gold,
  busy,
}: {
  projectId: string;
  schema: TaskSchema;
  data: Record<string, unknown>;
  gold: GoldPanelData;
  busy: boolean;
}) {
  const [answer, setAnswer] = useState<Answer | null>(gold.answer);
  const preference = (answer as { preference?: Preference } | null)?.preference ?? null;
  const stale = gold.rescore?.changes.length ?? 0;

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          {gold.isQualification ? 'Qualification question' : 'Gold task'}
        </h2>
        {gold.retiredAt && <Badge tone="slate">Retired {formatDateTime(gold.retiredAt)}</Badge>}
        {gold.source && (
          <Link
            to={`/projects/${projectId}/tasks/${gold.source.id}`}
            className="text-sm text-indigo-700 hover:underline"
          >
            Copied from task #{gold.source.position}
          </Link>
        )}
      </div>

      <Form method="post" className="space-y-3">
        <h3 className="text-sm font-medium text-slate-700">Expected answer</h3>
        {schema.kind === 'pairwise' ? (
          <fieldset className="flex flex-wrap gap-4 text-sm">
            <legend className="sr-only">Expected preference</legend>
            {(
              [
                ['A', 'Response A is better'],
                ['tie', 'About the same'],
                ['B', 'Response B is better'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="preference"
                  value={value}
                  checked={preference === value}
                  onChange={() =>
                    setAnswer({ preference: value, scores: { a: {}, b: {} }, rationale: '' })
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
        ) : (
          <LabelingInterface schema={schema} data={data} value={answer} onChange={setAnswer} />
        )}
        <input type="hidden" name="gold" value={answer ? JSON.stringify(answer) : ''} />
        <ReasonField id="gold-edit-reason" />
        <p className="text-xs text-slate-500">
          {gold.isQualification
            ? 'Past attempts are not regraded: their score and outcome are stored results. New attempts are graded against the new answer. To let someone try again, reset their qualification on the Members tab.'
            : 'Saving keeps the old answer in the history below and does not touch scores that were already given. Rescoring is a separate step, shown here once the answer has changed.'}
        </p>
        <Button name="intent" value="gold-edit" disabled={busy}>
          Save expected answer
        </Button>
      </Form>

      {gold.isGold && gold.rescore && (
        <div className="space-y-2 rounded-md bg-slate-50 p-4 text-sm">
          <h3 className="font-medium text-slate-700">Scores</h3>
          {stale === 0 ? (
            <p className="text-slate-600">
              All {gold.rescore.submissions} stored answer
              {gold.rescore.submissions === 1 ? '' : 's'} are scored against the expected answer as
              it is now.
            </p>
          ) : (
            <>
              <p className="text-slate-700">
                {stale} of {gold.rescore.submissions} stored answer
                {gold.rescore.submissions === 1 ? ' was' : 's were'} scored against an earlier
                expected answer. Rescoring would change{' '}
                {stale === 1 ? 'that score' : 'those scores'}.
              </p>
              <Impact impact={gold.rescore.impact} names={gold.names} />
              <p className="text-xs text-slate-500">{NO_CLAWBACK}</p>
              <Form method="post">
                {/* what was previewed: the rescore is refused if it would do something else */}
                <input type="hidden" name="digest" value={gold.rescore.digest} />
                <Button name="intent" value="gold-rescore" disabled={busy}>
                  Rescore {stale} answer{stale === 1 ? '' : 's'}
                </Button>
              </Form>
            </>
          )}
        </div>
      )}

      {gold.isGold && (
        <Form method="post" className="space-y-2 rounded-md bg-slate-50 p-4 text-sm">
          <h3 className="font-medium text-slate-700">
            {gold.retiredAt ? 'Bring this gold task back' : 'Retire this gold task'}
          </h3>
          <p className="text-slate-600">
            {gold.retiredAt
              ? 'It goes back into the queue and its scores count again.'
              : 'It is no longer handed out and its scores stop counting. The scores are kept, so it can be brought back.'}
          </p>
          {gold.retireImpact && <Impact impact={gold.retireImpact} names={gold.names} />}
          <p className="text-xs text-slate-500">{NO_CLAWBACK}</p>
          <ReasonField id="gold-retire-reason" />
          <Button
            name="intent"
            value={gold.retiredAt ? 'gold-restore' : 'gold-retire'}
            variant="secondary"
            disabled={busy}
          >
            {gold.retiredAt ? 'Bring back' : 'Retire'}
          </Button>
        </Form>
      )}

      {gold.revisions.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-slate-700">History</h3>
          <ul className="space-y-2 text-sm text-slate-600">
            {gold.revisions.map((r) => (
              <li key={r.id}>
                <span className="font-medium">{r.by}</span> {CHANGE_WORDS[r.change]}
                {r.change === 'EDITED' && ` from “${r.from}” to “${r.to}”`}
                {r.change === 'CREATED' && r.to && ` with “${r.to}”`}
                <span className="text-slate-500"> · {formatDateTime(r.at)}</span>
                <div className="text-slate-500">{r.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
