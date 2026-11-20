import { useState } from 'react';
import { Link } from 'react-router';

import { BarChart } from '~/components/bar-chart';
import { Card, EmptyState, StatCard as Stat } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import { describeKappa } from '~/domain/agreement';
import { requireUser } from '~/lib/auth.server';
import { projectTitle } from '~/lib/meta';
import { lowestGoldTasks } from '~/models/gold.server';
import { requireProject } from '~/models/projects.server';
import { suggestionQuality } from '~/models/prelabel.server';
import { dailyThroughput, projectQuality } from '~/models/quality.server';

import type { Route } from './+types/project-quality';

export function meta({ matches }: Route.MetaArgs) {
  return projectTitle(matches, 'Quality');
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'viewQuality');
  const [quality, daily, lowestGold, suggestions] = await Promise.all([
    projectQuality(project),
    dailyThroughput(project.id),
    lowestGoldTasks(project),
    suggestionQuality(project),
  ]);
  return { ...quality, daily, lowestGold, suggestions, projectId: project.id };
}

function pct(value: number | null): string {
  return value === null ? '–' : `${Math.round(value * 100)}%`;
}

type SortKey =
  | 'name'
  | 'submitted'
  | 'skipped'
  | 'reviewedShare'
  | 'approvalRate'
  | 'sentBack'
  | 'avgQaScore'
  | 'goldAccuracy'
  | 'avgSeconds'
  | 'tasksPerHour';

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'reviewedShare', label: 'Reviewed' },
  { key: 'approvalRate', label: 'Approval' },
  { key: 'sentBack', label: 'Sent back' },
  { key: 'avgQaScore', label: 'QA score' },
  { key: 'goldAccuracy', label: 'Gold' },
  { key: 'avgSeconds', label: 'Avg time' },
  { key: 'tasksPerHour', label: 'Tasks / hour' },
];

export default function ProjectQuality({ loaderData }: Route.ComponentProps) {
  const { annotators, agreement, skipReasons, daily, lowestGold, suggestions, projectId } =
    loaderData;
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'submitted',
    desc: true,
  });
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' }));
  const sorted = [...annotators].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    // empty values always go last
    if (x === null) return 1;
    if (y === null) return -1;
    const cmp = typeof x === 'string' ? x.localeCompare(String(y)) : Number(x) - Number(y);
    return sort.desc ? -cmp : cmp;
  });
  if (annotators.length === 0) {
    return (
      <EmptyState title="No submissions yet">
        Quality numbers appear once people start labeling.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {agreement.categorical ? (
          <Stat
            label="Fleiss' kappa"
            value={agreement.fleiss === null ? '–' : agreement.fleiss.toFixed(2)}
            hint={describeKappa(agreement.fleiss)}
          />
        ) : (
          <Stat
            label="Mean task agreement (F1)"
            value={pct(agreement.meanTaskAgreement)}
            hint="Across completed tasks"
          />
        )}
        <Stat
          label="Completed tasks"
          value={String(agreement.completedTasks)}
          hint={
            agreement.adjudicatedTasks > 0 || agreement.waitingAdjudication > 0
              ? `${agreement.majorityTasks} from the answers, ${agreement.adjudicatedTasks} adjudicated, ${agreement.waitingAdjudication} waiting`
              : undefined
          }
        />
        <Stat
          label="Submissions"
          value={String(annotators.reduce((s, a) => s + a.submitted, 0))}
          hint={`${annotators.length} annotators`}
        />
      </div>

      <Card>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Submissions per day <span className="font-normal normal-case">(dark: accepted)</span>
        </h2>
        <BarChart
          bars={daily.map((d) => ({
            label: d.day.slice(5),
            value: d.submitted,
            secondary: d.accepted,
          }))}
        />
      </Card>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Annotators
          </h2>
          <a
            href={`/projects/${projectId}/quality.csv`}
            className="text-sm text-indigo-700 hover:underline"
          >
            Download CSV
          </a>
        </div>
        <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className={`px-4 py-2 ${col.key === 'name' ? '' : 'text-right'}`}
                    aria-sort={
                      sort.key === col.key ? (sort.desc ? 'descending' : 'ascending') : undefined
                    }
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="uppercase hover:text-slate-800"
                    >
                      {col.label}
                      {sort.key === col.key ? (sort.desc ? ' ↓' : ' ↑') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map((a) => (
                <tr key={a.userId}>
                  <td className="px-4 py-2 font-medium">
                    <Link
                      to={`/projects/${projectId}/annotators/${a.userId}`}
                      className="hover:text-indigo-700"
                    >
                      {a.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right">{a.submitted}</td>
                  <td className="px-4 py-2 text-right">{a.skipped}</td>
                  <td
                    className="px-4 py-2 text-right"
                    title={`A reviewer decided on ${a.reviewedSubmissions} of ${a.reviewable} submissions (gold tasks not counted)`}
                  >
                    {pct(a.reviewedShare)}
                  </td>
                  <td className="px-4 py-2 text-right">{pct(a.approvalRate)}</td>
                  <td className="px-4 py-2 text-right">{a.sentBack}</td>
                  <td className="px-4 py-2 text-right">{a.avgQaScore?.toFixed(1) ?? '–'}</td>
                  <td
                    className={`px-4 py-2 text-right ${a.flagged ? 'font-medium text-rose-700' : ''}`}
                    title={`${a.goldAttempts} gold task${a.goldAttempts === 1 ? '' : 's'}`}
                  >
                    {pct(a.goldAccuracy)}
                    {a.flagged && (
                      <>
                        <span aria-hidden> ⚑</span>
                        <span className="sr-only"> (flagged for low gold accuracy)</span>
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {a.avgSeconds === null ? '–' : formatDuration(a.avgSeconds)}
                  </td>
                  <td className="px-4 py-2 text-right">{a.tasksPerHour ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {lowestGold.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Gold tasks with the lowest scores
          </h2>
          <p className="mb-2 text-sm text-slate-500">
            A gold task that most people miss is usually the one that is wrong. Tasks with at least
            two answers, lowest average first.
          </p>
          <ul className="divide-y divide-slate-100 rounded-lg bg-white text-sm shadow-sm ring-1 ring-slate-200">
            {lowestGold.map((g) => (
              <li key={g.taskId} className="flex items-center justify-between gap-3 px-4 py-2">
                <Link
                  to={`/projects/${projectId}/tasks/${g.taskId}`}
                  className="min-w-0 flex-1 truncate hover:text-indigo-700"
                >
                  {g.externalId && (
                    <span className="mr-2 font-mono text-xs text-slate-500">{g.externalId}</span>
                  )}
                  {g.preview}
                </Link>
                <span className="text-slate-500">
                  {pct(g.average)} over {g.answers} answers
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {skipReasons.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Skip reasons
          </h2>
          <ul className="divide-y divide-slate-100 rounded-lg bg-white text-sm shadow-sm ring-1 ring-slate-200">
            {skipReasons.map((s) => (
              <li key={s.reason} className="flex justify-between px-4 py-2">
                <span>{s.reason}</span>
                <span className="font-medium">{s.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {agreement.categorical && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Pairwise agreement (Cohen&apos;s kappa)
          </h2>
          {agreement.pairs.length === 0 ? (
            <p className="text-sm text-slate-500">
              Pairs of annotators need at least three tasks in common.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg bg-white text-sm shadow-sm ring-1 ring-slate-200">
              {agreement.pairs.map((p) => (
                <li key={`${p.a}-${p.b}`} className="flex justify-between px-4 py-2">
                  <span>
                    {p.a} &amp; {p.b} <span className="text-slate-500">({p.shared} shared)</span>
                  </span>
                  <span>
                    {p.kappa === null ? '–' : p.kappa.toFixed(2)}{' '}
                    <span className="text-slate-500">{describeKappa(p.kappa)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {suggestions.tasks > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Suggested answers
          </h2>
          <p className="mb-2 text-sm text-slate-600">
            {suggestions.tasks} task{suggestions.tasks === 1 ? ' has' : 's have'} a suggested
            answer. Every annotator of a task sees the same suggestion, so agreement and the
            consensus lean towards it: high agreement here says less than on tasks without one.
            Suggestions are not answers and count nowhere else.
          </p>
          {suggestions.againstGold.length > 0 && (
            <ul className="mb-3 text-sm">
              {suggestions.againstGold.map((g) => (
                <li key={g.source}>
                  {g.source === 'file'
                    ? 'Suggestions from the import file'
                    : `The ${g.source} rule`}{' '}
                  scores <span className="font-medium">{pct(g.score)}</span> against the gold
                  answers on {g.tasks} gold task{g.tasks === 1 ? '' : 's'}.
                </li>
              ))}
            </ul>
          )}
          {suggestions.annotators.length > 0 && (
            <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Annotator</th>
                    <th className="px-4 py-2 text-right">With a suggestion</th>
                    <th className="px-4 py-2 text-right">Handed in unchanged</th>
                    <th className="px-4 py-2 text-right">Average time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {suggestions.annotators.map((a) => (
                    <tr key={a.userId}>
                      <td className="px-4 py-2 font-medium">{a.name}</td>
                      <td className="px-4 py-2 text-right">{a.withSuggestion}</td>
                      <td className="px-4 py-2 text-right">
                        {pct(a.withSuggestion ? a.unchanged / a.withSuggestion : null)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {a.avgSeconds === null ? '–' : formatDuration(a.avgSeconds)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
