import { Fragment } from 'react';
import { data, Form, Link } from 'react-router';

import { Alert, Button, EmptyState, Input, PageHeader, StatCard } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import { CLOSE_REFUSALS, closeRefusal, periodBounds } from '~/domain/pay-runs';
import { formatCents } from '~/domain/payouts';
import { requireRole } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { parseDay, readRange, toDay } from '~/lib/dates';
import { redirectWithFlash } from '~/lib/flash.server';
import { closePayRun, listPayRuns } from '~/models/pay-runs.server';
import { payoutReport } from '~/models/payouts.server';

import type { Route } from './+types/payouts';

export function meta() {
  return [{ title: 'Payouts · Labeling Portal' }];
}

const lastDay = (end: Date) => toDay(new Date(end.getTime() - 24 * 3600_000));

export async function loader({ request }: Route.LoaderArgs) {
  const { membership } = await requireRole(request, ['ADMIN', 'PROJECT_MANAGER']);
  const range = readRange(new URL(request.url));
  const projectId = new URL(request.url).searchParams.get('project') || null;
  const [report, projects, runs] = await Promise.all([
    payoutReport(membership.orgId, range, projectId),
    prisma.project.findMany({
      where: { orgId: membership.orgId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    listPayRuns(membership.orgId),
  ]);
  // whether the range on screen can be closed, for the button; the action checks again
  const closable = closeRefusal(
    periodBounds(range),
    new Date(),
    runs.map((r) => ({ start: r.periodStart, end: r.periodEnd })),
  );
  return {
    range,
    projectId,
    projects,
    ...report,
    canClose: membership.role === 'ADMIN',
    closeRefused: closable ? CLOSE_REFUSALS[closable] : null,
    runs: runs.map((r) => ({
      id: r.id,
      from: toDay(r.periodStart),
      to: lastDay(r.periodEnd),
      closedBy: r.closedByName,
      closedAt: r.closedAt,
      totalCents: r.totalCents,
      note: r.note,
      lines: r._count.lines,
    })),
  };
}

/**
 * POST: an admin closes the period on screen as paid, for the whole
 * organisation. Refused for a period that is not over or that overlaps a
 * closed run.
 */
export async function action({ request }: Route.ActionArgs) {
  const { membership, user } = await requireRole(request, ['ADMIN']);
  const form = await request.formData();
  const from = parseDay(String(form.get('from') ?? ''));
  const to = parseDay(String(form.get('to') ?? ''));
  if (!from || !to) return data({ error: 'Choose the first and the last day.' }, { status: 400 });
  const range = { from, to };
  const note = String(form.get('note') ?? '')
    .trim()
    .slice(0, 500);
  const closed = await closePayRun(membership.orgId, user.id, range, note);
  if (!closed.ok) return data({ error: CLOSE_REFUSALS[closed.error] }, { status: 409 });
  return redirectWithFlash(
    request,
    `/payouts?from=${range.from}&to=${range.to}`,
    `Closed ${range.from} to ${range.to} as paid: ${formatCents(closed.totalCents)}. Its CSV is kept as it is now.`,
  );
}

export default function Payouts({ loaderData, actionData }: Route.ComponentProps) {
  const { range, lines, totalCents, pending, projects, projectId, runs, canClose, closeRefused } =
    loaderData;
  const query = new URLSearchParams({
    ...range,
    ...(projectId ? { project: projectId } : {}),
  }).toString();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payouts"
        subtitle="Accepted work only, counted on the day it became payable: the day a reviewer approved or corrected it, or the day it was submitted when no review was needed. Work accepted before this rule came in counts on the day it was submitted. Each task is paid at the rate its project had when it was submitted. Dates are inclusive and in UTC."
        actions={
          <a href={`/payouts/export?${query}`} download>
            <Button variant="secondary">Download CSV</Button>
          </a>
        }
      />
      <Form className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">From</span>
          <Input type="date" name="from" defaultValue={range.from} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">To</span>
          <Input type="date" name="to" defaultValue={range.to} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Project</span>
          <select
            name="project"
            defaultValue={projectId ?? ''}
            className="block rounded-md border-0 py-2 pl-2 pr-8 text-sm ring-1 ring-slate-300"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Update
        </Button>
        <Link to="/payouts" className="py-2 text-sm text-slate-500 hover:text-slate-800">
          This month
        </Link>
      </Form>

      {actionData?.error && <Alert>{actionData.error}</Alert>}
      {canClose && !projectId && (
        <Form
          method="post"
          className="flex flex-wrap items-end gap-3 rounded-lg bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200"
          onSubmit={(event) => {
            if (
              !confirm(
                `Close ${range.from} to ${range.to} as paid? A closed run cannot be reopened.`,
              )
            )
              event.preventDefault();
          }}
        >
          <input type="hidden" name="from" value={range.from} />
          <input type="hidden" name="to" value={range.to} />
          <label className="min-w-64 flex-1">
            <span className="mb-1 block text-slate-600">Note (optional)</span>
            <Input name="note" maxLength={500} placeholder="Paid by bank transfer on ..." />
          </label>
          <Button type="submit" disabled={closeRefused !== null}>
            Close this period as paid
          </Button>
          <p className="w-full text-slate-500">
            {closeRefused ??
              'Copies this report for every project into a closed run and marks the work in it as paid. Work that becomes payable for a closed day later is paid in the next run.'}
          </p>
        </Form>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total owed" value={formatCents(totalCents)} />
        <StatCard label="People" value={lines.length} />
        <StatCard
          label="Waiting for review"
          value={pending}
          hint="submitted in this period, not payable until accepted"
        />
      </div>

      {lines.length === 0 ? (
        <EmptyState title="No accepted work in this period" />
      ) : (
        <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Annotator</th>
                <th className="px-4 py-2">Project</th>
                <th className="px-4 py-2 text-right">Tasks</th>
                <th className="px-4 py-2 text-right">Time</th>
                <th className="px-4 py-2 text-right">Rate</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <Fragment key={line.userId}>
                  {line.projects.map((p, i) => (
                    <tr
                      key={`${line.userId}-${p.projectId}-${p.payMode}-${p.rateCents}`}
                      className={i === 0 ? 'border-t border-slate-200' : ''}
                    >
                      <td className="px-4 py-2 align-top">
                        {i === 0 && (
                          <>
                            <div className="font-medium">{line.name}</div>
                            <div className="text-xs text-slate-500">{line.email}</div>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2">{p.projectName}</td>
                      <td className="px-4 py-2 text-right">{p.tasks}</td>
                      <td className="px-4 py-2 text-right">{formatDuration(p.seconds)}</td>
                      <td className="px-4 py-2 text-right text-slate-500">
                        {formatCents(p.rateCents)}
                        {p.payMode === 'HOURLY' ? '/h' : '/task'}
                      </td>
                      <td className="px-4 py-2 text-right">{formatCents(p.amountCents)}</td>
                    </tr>
                  ))}
                  {line.projects.length > 1 && (
                    <tr key={`${line.userId}-total`} className="bg-slate-50/60">
                      <td />
                      <td className="px-4 py-1 text-xs font-medium uppercase text-slate-500">
                        Total
                      </td>
                      <td className="px-4 py-1 text-right">{line.tasks}</td>
                      <td className="px-4 py-1 text-right">{formatDuration(line.seconds)}</td>
                      <td />
                      <td className="px-4 py-1 text-right font-medium">
                        {formatCents(line.amountCents)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Closed runs
        </h2>
        {runs.length === 0 ? (
          <EmptyState title="No period has been closed as paid yet" />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg bg-white text-sm shadow-sm ring-1 ring-slate-200">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                <span className="font-medium">
                  {run.from} to {run.to}
                </span>
                <span>{formatCents(run.totalCents)}</span>
                <span className="text-slate-500">
                  closed by {run.closedBy} on {run.closedAt.toISOString().slice(0, 10)}
                  {run.note && ` · ${run.note}`}
                </span>
                <a
                  href={`/payouts/runs/${run.id}/export`}
                  download
                  className="ml-auto text-indigo-700 hover:underline"
                >
                  CSV
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
