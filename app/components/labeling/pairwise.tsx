import { useId, useRef } from 'react';

import type { PairwiseAnswer, Preference } from '~/domain/answers';
import {
  interfaceShortcut,
  nextScoreGroup,
  scoreGroups,
  scoreTarget,
  type ScoreGroup,
} from '~/domain/hotkeys';
import type { PairwiseSchema } from '~/domain/task-schema';

import { cx } from '../ui';

import type { LabelingProps } from './index';
import { useInterfaceHotkeys } from './use-hotkeys';

// The preference starts out unset; the server rejects drafts without one.
const EMPTY = {
  preference: null,
  scores: { a: {}, b: {} },
  rationale: '',
} as unknown as PairwiseAnswer;

const groupId = (group: ScoreGroup) => `${group.side}:${group.dimension}`;

/**
 * One score row: real radio buttons, so the group is one tab stop and the
 * arrow keys choose, as in any radio group. The digits are handled by the
 * interface, which finds the group through `data-score-group`.
 */
function ScoreButtons({
  name,
  label,
  group,
  value,
  onPick,
  readOnly,
}: {
  name: string;
  label: string;
  group: ScoreGroup;
  value: number | undefined;
  onPick: (n: number) => void;
  readOnly?: boolean;
}) {
  return (
    <div
      className="flex gap-1"
      role="radiogroup"
      aria-label={label}
      data-score-group={groupId(group)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <label key={n} className="relative">
          <input
            type="radio"
            name={name}
            value={n}
            checked={value === n}
            disabled={readOnly}
            onChange={() => onPick(n)}
            className="peer sr-only"
          />
          <span
            className={cx(
              'grid h-7 w-7 place-items-center rounded text-xs font-medium ring-1',
              'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-indigo-600',
              value === n ? 'bg-indigo-600 text-white ring-indigo-600' : 'bg-white ring-slate-300',
              !readOnly && 'cursor-pointer',
              !readOnly && value !== n && 'hover:bg-slate-50',
            )}
          >
            {n}
          </span>
        </label>
      ))}
    </div>
  );
}

export function PairwiseRubric({
  schema,
  data,
  value,
  onChange,
  readOnly,
}: LabelingProps<PairwiseSchema, PairwiseAnswer>) {
  const draft = value ?? EMPTY;
  const update = (patch: Partial<PairwiseAnswer>) => onChange({ ...draft, ...patch });

  const setScore = (side: 'a' | 'b', key: string, n: number) =>
    update({ scores: { ...draft.scores, [side]: { ...draft.scores[side], [key]: n } } });

  const preferences: Array<{ value: Preference; label: string }> = [
    { value: 'A', label: 'A is better' },
    ...(schema.allowTie ? [{ value: 'tie' as const, label: 'About the same' }] : []),
    { value: 'B', label: 'B is better' },
  ];
  const length = draft.rationale.trim().length;
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const groups = scoreGroups(schema.dimensions.map((d) => d.key));

  /** Puts the cursor on a score group: on its chosen score, else on the first. */
  const focusGroup = (group: ScoreGroup, score?: number) => {
    const row = Array.from(
      root.current?.querySelectorAll<HTMLElement>('[data-score-group]') ?? [],
    ).find((el) => el.dataset.scoreGroup === groupId(group));
    const inputs = Array.from(row?.querySelectorAll<HTMLInputElement>('input') ?? []);
    const wanted = score ?? draft.scores[group.side][group.dimension];
    (inputs.find((input) => Number(input.value) === wanted) ?? inputs[0])?.focus();
  };

  const inUse = useInterfaceHotkeys(schema, readOnly, (hit) => {
    if (hit.action === 'score') {
      // the group that has focus, or the first one that has no score yet
      const at = document.activeElement?.closest<HTMLElement>('[data-score-group]');
      const focused =
        at && root.current?.contains(at)
          ? (groups.find((g) => groupId(g) === at.dataset.scoreGroup) ?? null)
          : null;
      const target = scoreTarget(groups, focused, draft.scores);
      if (!target) return false;
      const score = hit.index + 1;
      setScore(target.side, target.dimension, score);
      const next = nextScoreGroup(groups, target);
      focusGroup(next, next === target ? score : undefined);
      return true;
    }
    const pick = ({ preferA: 'A', preferB: 'B', preferTie: 'tie' } as const)[
      hit.action as 'preferA' | 'preferB' | 'preferTie'
    ] as Preference | undefined;
    if (!pick) return false;
    update({ preference: pick });
    return true;
  });

  return (
    <div className="space-y-5" ref={root} {...inUse}>
      <section>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Prompt</h3>
        <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm leading-6">
          {String(data[schema.promptField] ?? '')}
        </p>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        {(['A', 'B'] as const).map((side) => {
          const text = String(
            data[side === 'A' ? schema.responseAField : schema.responseBField] ?? '',
          );
          const words = text.trim() ? text.trim().split(/\s+/).length : 0;
          return (
            <section key={side} className="rounded-md ring-1 ring-slate-200">
              <h3 className="flex justify-between border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-semibold">
                Response {side}
                <span className="font-normal text-slate-500">
                  {words} word{words === 1 ? '' : 's'}
                </span>
              </h3>
              <p className="max-h-96 overflow-y-auto whitespace-pre-wrap p-3 text-sm leading-6">
                {text}
              </p>
            </section>
          );
        })}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-1">
              Dimension
              {!readOnly && (
                <span className="ml-2 normal-case text-slate-500">
                  (keys {interfaceShortcut(schema, ['score'])}, row by row)
                </span>
              )}
            </th>
            <th className="py-1">Response A</th>
            <th className="py-1">Response B</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {schema.dimensions.map((dim) => (
            <tr key={dim.key}>
              <td className="py-2 pr-3">
                <div className="font-medium">{dim.label}</div>
                {dim.description && <div className="text-xs text-slate-500">{dim.description}</div>}
              </td>
              <td className="py-2">
                <ScoreButtons
                  name={`${id}-a-${dim.key}`}
                  label={`${dim.label} for A`}
                  group={{ dimension: dim.key, side: 'a' }}
                  value={draft.scores.a[dim.key]}
                  onPick={(n) => setScore('a', dim.key, n)}
                  readOnly={readOnly}
                />
              </td>
              <td className="py-2">
                <ScoreButtons
                  name={`${id}-b-${dim.key}`}
                  label={`${dim.label} for B`}
                  group={{ dimension: dim.key, side: 'b' }}
                  value={draft.scores.b[dim.key]}
                  onPick={(n) => setScore('b', dim.key, n)}
                  readOnly={readOnly}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <fieldset>
        <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          Overall preference
          {!readOnly && (
            <span className="ml-2 normal-case text-slate-500">
              (keys {interfaceShortcut(schema, ['preferA', 'preferB', 'preferTie'])})
            </span>
          )}
        </legend>
        {/* a real radio group, like the score rows: one tab stop, the arrows choose */}
        <div className="flex flex-wrap gap-2">
          {preferences.map((p) => {
            const chosen = draft.preference === p.value;
            return (
              <label key={p.value} className="relative">
                <input
                  type="radio"
                  name={`${id}-preference`}
                  value={p.value}
                  checked={chosen}
                  disabled={readOnly}
                  onChange={() => update({ preference: p.value })}
                  className="peer sr-only"
                />
                <span
                  className={cx(
                    'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium ring-1',
                    'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-indigo-600',
                    chosen ? 'bg-indigo-600 text-white ring-indigo-600' : 'bg-white ring-slate-300',
                    !readOnly && 'cursor-pointer',
                    !readOnly && !chosen && 'hover:bg-slate-50',
                  )}
                >
                  {p.label}
                  {chosen && (
                    <span aria-hidden className="ml-1.5">
                      ✓
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div>
        <label
          htmlFor={`${id}-rationale`}
          className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500"
        >
          Rationale
        </label>
        <textarea
          id={`${id}-rationale`}
          rows={4}
          readOnly={readOnly}
          value={draft.rationale}
          onChange={(event) => update({ rationale: event.target.value })}
          placeholder="Why is one response better? Point to specific problems."
          className="block w-full rounded-md px-3 py-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-600"
        />
        {!readOnly && (
          <p
            className={cx(
              'mt-1 text-xs',
              length < schema.minRationaleLength ? 'text-amber-700' : 'text-slate-500',
            )}
          >
            {length} / {schema.minRationaleLength} characters minimum
          </p>
        )}
      </div>
    </div>
  );
}
