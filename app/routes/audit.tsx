import { Form, Link } from 'react-router';

import { Pagination } from '~/components/pagination';
import { Button, EmptyState, Input, PageHeader } from '~/components/ui';
import { ACTIVITY_ACTIONS } from '~/domain/activity';
import { prisma } from '~/lib/db.server';
import { formatDateTime } from '~/lib/format';
import { paginate, readPage } from '~/lib/pagination';
import { countActivity, listActivity, readActivityFilter } from '~/models/activity.server';
import { auditLine, requireAuditor } from '~/models/audit.server';

import type { Route } from './+types/audit';

export function meta() {
  return [{ title: 'Audit · Labeling Portal' }];
}

/**
 * The organisation's audit trail for admins: who changed what, signed in or
 * downloaded what, newest first, with filters and pages. Only entries of
 * the admin's own organisation are read.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { membership } = await requireAuditor(request);
  const url = new URL(request.url);
  const filter = readActivityFilter(url, membership.orgId);
  const page = paginate(await countActivity(filter), readPage(url));
  const [entries, people, projects] = await Promise.all([
    listActivity(filter, page),
    // people who have entries, those who left included, for the person filter
    prisma.activity.findMany({
      where: { orgId: membership.orgId, actorId: { not: null } },
      distinct: ['actorId'],
      select: { actorId: true, actorName: true },
      orderBy: { actorId: 'asc' },
    }),
    prisma.project.findMany({
      where: { orgId: membership.orgId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  const query = new URLSearchParams(url.search);
  query.delete('page');
  return {
    entries: entries.map(auditLine),
    page,
    filter: {
      person: filter.actorId ?? '',
      action: filter.action ?? '',
      project: filter.projectId ?? '',
      from: filter.range?.from ?? '',
      to: filter.range?.to ?? '',
    },
    people: people
      .map((p) => ({ id: p.actorId!, name: p.actorName }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    projects,
    actions: Object.entries(ACTIVITY_ACTIONS).map(([value, label]) => ({ value, label })),
    query: query.toString(),
  };
}

const selectClass = 'block rounded-md border-0 py-2 pl-2 pr-8 text-sm ring-1 ring-slate-300';

export default function Audit({ loaderData }: Route.ComponentProps) {
  const { entries, page, filter, people, projects, actions, query } = loaderData;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit"
        subtitle="What managers, reviewers and admins changed, sign-ins and downloads, newest first. Entries are never changed or removed. Dates are in UTC."
        actions={
          <a href={`/audit/export?${query}`} download>
            <Button variant="secondary">Download CSV</Button>
          </a>
        }
      />
      <Form className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Person</span>
          <select name="person" defaultValue={filter.person} className={selectClass}>
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Action</span>
          <select name="action" defaultValue={filter.action} className={selectClass}>
            <option value="">Any action</option>
            {actions.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Project</span>
          <select name="project" defaultValue={filter.project} className={selectClass}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">From</span>
          <Input type="date" name="from" defaultValue={filter.from} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">To</span>
          <Input type="date" name="to" defaultValue={filter.to} />
        </label>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        <Link to="/audit" className="py-2 text-sm text-slate-500 hover:text-slate-800">
          Clear
        </Link>
      </Form>

      {entries.length === 0 ? (
        <EmptyState title="No entries match" />
      ) : (
        <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Who</th>
                <th className="px-4 py-2">What</th>
                <th className="px-4 py-2">Project</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                    {formatDateTime(e.createdAt)}
                  </td>
                  <td className="px-4 py-2 font-medium">{e.actor}</td>
                  <td className="px-4 py-2">{e.text}</td>
                  <td className="px-4 py-2">
                    {e.projectId && e.project ? (
                      <Link
                        to={`/projects/${e.projectId}`}
                        className="text-indigo-700 hover:underline"
                      >
                        {e.project}
                      </Link>
                    ) : (
                      <span className="text-slate-400">–</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination info={page} />
    </div>
  );
}
