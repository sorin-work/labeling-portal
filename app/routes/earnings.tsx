import { Form, Link } from 'react-router';

import { Button, Card, EmptyState, Input, PageHeader, StatCard } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import { formatCents, type ProjectPayout } from '~/domain/payouts';
import { requireUser } from '~/lib/auth.server';
import { readRange } from '~/lib/dates';
import { earningsReport } from '~/models/payouts.server';

import type { Route } from './+types/earnings';

export function meta() {
  return [{ title: 'Earnings · Labeling Portal' }];
}

/**
 * A person's own earnings. Whose they are comes from the session and from
 * nothing else: there is no parameter that names another person.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { user, membership } = await requireUser(request);
  const range = readRange(new URL(request.url));
  return { range, ...(await earningsReport(membership.orgId, user.id, range)) };
}

const tasks = (n: number) => (n === 1 ? '1 task' : `${n} tasks`);

function rate(block: ProjectPayout): string {
  return `${formatCents(block.rateCents)}${block.payMode === 'HOURLY' ? '/h' : '/task'}`;
}

function BlockRows({ blocks, state }: { blocks: ProjectPayout[]; state?: string }) {
  return blocks.map((block) => (
    <tr
      key={`${state ?? 'payable'}-${block.projectId}-${block.payMode}-${block.rateCents}`}
      className="border-t border-slate-200"
    >
      <td className="px-4 py-2">{block.projectName}</td>
      {state && <td className="px-4 py-2 text-slate-600">{state}</td>}
      <td className="px-4 py-2 text-right">{block.tasks}</td>
      <td className="px-4 py-2 text-right">{formatDuration(block.seconds)}</td>
      <td className="px-4 py-2 text-right text-slate-500">{rate(block)}</td>
      <td className="px-4 py-2 text-right">{formatCents(block.amountCents)}</td>
    </tr>
  ));
}

const tableClass = 'w-full text-sm';
const headClass = 'bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500';

export default function Earnings({ loaderData }: Route.ComponentProps) {
  const { range, payable, waiting, sentBack } = loaderData;
  const notPayable = waiting.tasks + sentBack.tasks;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Earnings"
        subtitle="Your own work only. Accepted work counts on the day it became payable. Dates are inclusive and in UTC."
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
        <Link to="/earnings" className="py-2 text-sm text-slate-500 hover:text-slate-800">
          This month
        </Link>
      </Form>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Payable for this period"
          value={formatCents(payable.totalCents)}
          hint={`${tasks(payable.tasks)} accepted`}
        />
        <StatCard
          label="Waiting for review"
          value={formatCents(waiting.totalCents)}
          hint={`${tasks(waiting.tasks)}, not payable until accepted`}
        />
        <StatCard
          label="Sent back to you"
          value={formatCents(sentBack.totalCents)}
          hint={`${tasks(sentBack.tasks)}, not payable until revised and accepted`}
        />
      </div>
      <p className="text-sm text-slate-600">
        Nothing on this page is marked as paid: the portal does not record payments. “Payable” is
        what you are owed for the period. When it is paid out is between you and your project
        manager.
      </p>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Payable for this period
        </h2>
        {payable.blocks.length === 0 ? (
          <EmptyState title="No work became payable in this period" />
        ) : (
          <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
            <table className={tableClass}>
              <thead className={headClass}>
                <tr>
                  <th className="px-4 py-2">Project</th>
                  <th className="px-4 py-2 text-right">Accepted tasks</th>
                  <th className="px-4 py-2 text-right">Active time</th>
                  <th className="px-4 py-2 text-right">Rate</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                <BlockRows blocks={payable.blocks} />
                <tr className="border-t border-slate-200 bg-slate-50/60 font-medium">
                  <td className="px-4 py-2">Total</td>
                  <td className="px-4 py-2 text-right">{payable.tasks}</td>
                  <td className="px-4 py-2 text-right">{formatDuration(payable.seconds)}</td>
                  <td />
                  <td className="px-4 py-2 text-right">{formatCents(payable.totalCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Not payable yet
        </h2>
        <p className="text-sm text-slate-600">
          All of your work that is waiting for a reviewer or was sent back, whatever the dates
          above. The amounts are what it earns if it is accepted.
          {sentBack.tasks > 0 && (
            <>
              {' '}
              <Link to="/my-work?filter=returned" className="text-indigo-700 hover:underline">
                Revise the work that was sent back
              </Link>
              .
            </>
          )}
        </p>
        {notPayable === 0 ? (
          <EmptyState title="Nothing is waiting" />
        ) : (
          <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
            <table className={tableClass}>
              <thead className={headClass}>
                <tr>
                  <th className="px-4 py-2">Project</th>
                  <th className="px-4 py-2">State</th>
                  <th className="px-4 py-2 text-right">Tasks</th>
                  <th className="px-4 py-2 text-right">Active time</th>
                  <th className="px-4 py-2 text-right">Rate</th>
                  <th className="px-4 py-2 text-right">If accepted</th>
                </tr>
              </thead>
              <tbody>
                <BlockRows blocks={waiting.blocks} state="Waiting for review" />
                <BlockRows blocks={sentBack.blocks} state="Sent back" />
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Card>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          How this is counted
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>
            Work counts on the day it became payable: the day a reviewer approved or corrected it,
            or the day you submitted it when no review was needed. Work submitted in one month and
            approved in the next belongs to the second. Work that was accepted before this rule came
            in counts on the day it was submitted, as it did then.
          </li>
          <li>
            Each task is paid at the rate its project had when you first submitted it. A later
            change of the rate does not touch it, so a project can show two lines.
          </li>
          <li>Gold tasks are paid like any other task. The qualification test is not paid.</li>
          <li>
            Hourly work is paid for active time. That includes the time you spend revising work that
            was sent back, up to the project&apos;s time limit for each revision and three time
            limits for a task in all. A first submission is paid for at most two time limits: asking
            for more time gives you time to finish, and time beyond two limits is not paid. The
            amount is rounded once, to the nearest cent, for each line above, not for each task.
            Adding up your tasks one by one can differ by a cent.
          </li>
        </ul>
      </Card>
    </div>
  );
}
