import type { Prisma } from '@prisma/client';
import { Form, Link } from 'react-router';

import { Pagination } from '~/components/pagination';
import { Badge, EmptyState, Input, PageHeader } from '~/components/ui';
import { taskPreview } from '~/domain/preview';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { formatDate, titleCase } from '~/lib/format';
import { notFound } from '~/lib/http';
import { paginate, readPage } from '~/lib/pagination';
import { projectSchema, requireProject } from '~/models/projects.server';

import type { Route } from './+types/batch-detail';

const STATUSES = ['OPEN', 'COMPLETE'] as const;

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.batch.name ?? 'Batch'} · Labeling Portal` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  const batch = await prisma.batch.findFirst({
    where: { id: params.batchId, projectId: project.id },
  });
  if (!batch) throw notFound('Batch not found');

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const status = STATUSES.find((s) => s === statusParam) ?? null;
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const schema = projectSchema(project);
  const textField =
    schema.kind === 'pairwise'
      ? schema.promptField
      : schema.kind === 'bbox'
        ? schema.imageField
        : schema.textField;
  const where: Prisma.TaskWhereInput = {
    batchId: batch.id,
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { externalId: { contains: q, mode: 'insensitive' } },
            { data: { path: [textField], string_contains: q } },
          ],
        }
      : {}),
  };

  const total = await prisma.task.count({ where });
  const page = paginate(total, readPage(url));
  const tasks = await prisma.task.findMany({
    where,
    orderBy: { position: 'asc' },
    skip: page.skip,
    take: page.take,
    select: { id: true, position: true, externalId: true, status: true, data: true, isGold: true },
  });

  return {
    projectId: project.id,
    batch: { id: batch.id, name: batch.name, format: batch.format, createdAt: batch.createdAt },
    status,
    q,
    page,
    tasks: tasks.map((t) => ({
      id: t.id,
      position: t.position,
      externalId: t.externalId,
      status: t.status,
      isGold: t.isGold,
      preview: taskPreview(schema, t.data),
    })),
  };
}

export default function BatchDetail({ loaderData }: Route.ComponentProps) {
  const { projectId, batch, tasks, page, status, q } = loaderData;
  const filters = [
    { label: 'All', value: null },
    { label: 'Open', value: 'OPEN' },
    { label: 'Complete', value: 'COMPLETE' },
  ];

  return (
    <div>
      <PageHeader
        title={batch.name}
        subtitle={`${batch.format} import · ${formatDate(batch.createdAt)} · ${page.total} tasks`}
      />
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {filters.map((f) => (
          <Link
            key={f.label}
            to={`?${new URLSearchParams({ ...(f.value ? { status: f.value } : {}), ...(q ? { q } : {}) })}`}
            className={
              status === f.value
                ? 'rounded-md bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700'
                : 'rounded-md px-3 py-1 text-sm text-slate-600 hover:bg-slate-100'
            }
          >
            {f.label}
          </Link>
        ))}
        <Form className="ml-auto">
          {status && <input type="hidden" name="status" value={status} />}
          <Input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search id or text"
            aria-label="Search tasks"
            className="w-56"
          />
        </Form>
      </div>
      {tasks.length === 0 ? (
        <EmptyState title="No tasks match this filter" />
      ) : (
        <table className="w-full overflow-hidden rounded-lg bg-white text-sm shadow-sm ring-1 ring-slate-200">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-16 px-4 py-2">#</th>
              <th className="px-4 py-2">Task</th>
              <th className="w-28 px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tasks.map((task) => (
              <tr key={task.id} className="hover:bg-slate-50">
                <td className="px-4 py-2 text-slate-400">{task.position}</td>
                <td className="max-w-0 px-4 py-2">
                  <Link
                    to={`/projects/${projectId}/tasks/${task.id}`}
                    className="block truncate hover:text-indigo-700"
                  >
                    {task.externalId && (
                      <span className="mr-2 font-mono text-xs text-slate-400">
                        {task.externalId}
                      </span>
                    )}
                    {task.preview}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  {task.isGold ? (
                    <Badge tone="amber">Gold</Badge>
                  ) : (
                    <Badge tone={task.status === 'COMPLETE' ? 'emerald' : 'slate'}>
                      {titleCase(task.status)}
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pagination info={page} />
    </div>
  );
}
