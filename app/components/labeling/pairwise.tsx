import type { PairwiseAnswer, Preference } from '~/domain/answers';
import type { PairwiseSchema } from '~/domain/task-schema';

import { cx } from '../ui';

import type { LabelingProps } from './index';
import { useHotkeys } from './use-hotkeys';

// The preference starts out unset; the server rejects drafts without one.
const EMPTY = {
  preference: null,
  scores: { a: {}, b: {} },
  rationale: '',
} as unknown as PairwiseAnswer;

function ScoreButtons({
  name,
  value,
  onPick,
  readOnly,
}: {
  name: string;
  value: number | undefined;
  onPick: (n: number) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label={name}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          disabled={readOnly}
          onClick={() => onPick(n)}
          className={cx(
            'h-7 w-7 rounded text-xs font-medium ring-1',
            value === n
              ? 'bg-indigo-600 text-white ring-indigo-600'
              : 'bg-white ring-slate-300 hover:bg-slate-50',
          )}
        >
          {n}
        </button>
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

  useHotkeys((key) => {
    const pick = { a: 'A', b: 'B', t: 'tie' }[key.toLowerCase()] as Preference | undefined;
    if (!pick || (pick === 'tie' && !schema.allowTie)) return false;
    update({ preference: pick });
    return true;
  }, !readOnly);

  return (
    <div className="space-y-5">
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
                <span className="font-normal text-slate-400">
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
            <th className="py-1">Dimension</th>
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
                  name={`${dim.label} for A`}
                  value={draft.scores.a[dim.key]}
                  onPick={(n) => setScore('a', dim.key, n)}
                  readOnly={readOnly}
                />
              </td>
              <td className="py-2">
                <ScoreButtons
                  name={`${dim.label} for B`}
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
            <span className="ml-2 normal-case text-slate-400">
              (keys a, b{schema.allowTie ? ', t' : ''})
            </span>
          )}
        </legend>
        <div className="flex flex-wrap gap-2">
          {preferences.map((p) => (
            <button
              key={p.value}
              type="button"
              aria-pressed={draft.preference === p.value}
              disabled={readOnly}
              onClick={() => update({ preference: p.value })}
              className={cx(
                'rounded-md px-3 py-1.5 text-sm font-medium ring-1',
                draft.preference === p.value
                  ? 'bg-indigo-600 text-white ring-indigo-600'
                  : 'bg-white ring-slate-300 hover:bg-slate-50',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </fieldset>
      <div>
        <label
          htmlFor="rationale"
          className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500"
        >
          Rationale
        </label>
        <textarea
          id="rationale"
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
