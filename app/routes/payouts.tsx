import { Fragment } from 'react';
import { Form, Link } from 'react-router';

import { Button, EmptyState, Input, PageHeader, StatCard } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import { formatCents } from '~/domain/payouts';
import { requireRole } from '~/lib/auth.server';
import { readRange } from '~/lib/dates';
import { payoutReport } from '~/models/payouts.server';

import type { Route } from './+types/payouts';

export function meta() {
  return [{ title: 'Payouts · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { membership } = await requireRole(request, ['ADMIN', 'PROJECT_MANAGER']);
  const range = readRange(new URL(request.url));
  const report = await payoutReport(membership.orgId, range);
  return { range, ...report };
}

export default function Payouts({ loaderData }: Route.ComponentProps) {
  const { range, lines, totalCents, pending } = loaderData;
  const query = new URLSearchParams(range).toString();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payouts"
        subtitle="Accepted work only. Dates are inclusive and in UTC."
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
        <Button type="submit" variant="secondary">
          Update
        </Button>
        <Link to="/payouts" className="py-2 text-sm text-slate-500 hover:text-slate-800">
          This month
        </Link>
      </Form>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total owed" value={formatCents(totalCents)} />
        <StatCard label="People" value={lines.length} />
        <StatCard label="Waiting for review" value={pending} hint="not paid until accepted" />
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
                      key={`${line.userId}-${p.projectId}`}
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
    </div>
  );
}
