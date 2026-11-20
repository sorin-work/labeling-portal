import type { Prisma } from '@prisma/client';
import { data, Form, Link } from 'react-router';

import { Pagination } from '~/components/pagination';
import { Alert, Badge, Button, EmptyState, Input, PageHeader } from '~/components/ui';
import { taskPreview } from '~/domain/preview';
import { MAX_BATCH_PRIORITY, parseBatchPriority } from '~/domain/queue-order';
import { refSuffix } from '~/domain/reference';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { formatDate, formatDateTime, titleCase } from '~/lib/format';
import { redirectWithFlash } from '~/lib/flash.server';
import { badRequest, notFound } from '~/lib/http';
import { paginate, readPage } from '~/lib/pagination';
import {
  batchStanding,
  deleteBatch,
  setBatchPaused,
  setBatchPriority,
} from '~/models/batches.server';
import { openBatches, promoteToGold } from '~/models/gold.server';
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
  // a reference an annotator quoted from the work page finds the task they had
  const ref = refSuffix(q);
  const where: Prisma.TaskWhereInput = {
    batchId: batch.id,
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { externalId: { contains: q, mode: 'insensitive' } },
            { data: { path: [textField], string_contains: q } },
            ...(ref ? [{ assignments: { some: { id: { endsWith: ref } } } }] : []),
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
    select: {
      id: true,
      position: true,
      externalId: true,
      status: true,
      data: true,
      isGold: true,
      isQualification: true,
      goldRetiredAt: true,
      consensus: true,
      goldCopies: { where: { goldRetiredAt: null }, select: { id: true } },
    },
  });

  return {
    projectId: project.id,
    batch: {
      id: batch.id,
      name: batch.name,
      format: batch.format,
      createdAt: batch.createdAt,
      priority: batch.priority,
      pausedAt: batch.pausedAt,
    },
    standing: await batchStanding(batch.id),
    status,
    q,
    page,
    openBatches: await openBatches(project.id),
    tasks: tasks.map((t) => ({
      id: t.id,
      position: t.position,
      externalId: t.externalId,
      status: t.status,
      isGold: t.isGold,
      goldRetired: t.goldRetiredAt !== null,
      // a completed task with a consensus that is not gold yet can become gold
      canBeGold:
        !t.isGold &&
        !t.isQualification &&
        t.status === 'COMPLETE' &&
        t.consensus !== null &&
        t.goldCopies.length === 0,
      preview: taskPreview(schema, t.data),
    })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  const form = await request.formData();
  if (form.get('intent') === 'gold-copy') {
    const taskIds = form.getAll('taskId').map(String).slice(0, 200);
    if (taskIds.length === 0)
      return data({ error: 'Tick the tasks to use as gold.' }, { status: 400 });
    const batchTasks = await prisma.task.findMany({
      where: { id: { in: taskIds }, batchId: params.batchId, projectId: project.id },
      select: { id: true },
    });
    const outcome = await promoteToGold(
      project,
      batchTasks.map((t) => t.id),
      current.user.id,
      { batchId: String(form.get('targetBatchId') ?? '') || null },
    );
    if (outcome.refused) {
      return data({ error: `No gold task was made: ${outcome.refused}.` }, { status: 409 });
    }
    const made = outcome.created.length;
    const skipped = taskIds.length - made;
    return redirectWithFlash(
      request,
      `/projects/${project.id}/batches/${params.batchId}`,
      `Made ${made} gold task${made === 1 ? '' : 's'} from the consensus.${
        skipped > 0
          ? ` Skipped ${skipped}: ${[...new Set(outcome.skipped.map((s) => s.why))].join('; ') || 'not in this batch'}.`
          : ''
      }`,
    );
  }
  // Where the batch stands in the queue. Like everything on this page it is
  // for managers (`manageProjects`, checked at the top of the action).
  const here = `/projects/${project.id}/batches/${params.batchId}`;
  if (form.get('intent') === 'priority') {
    const priority = parseBatchPriority(form.get('priority'));
    if (!priority.ok) return data({ error: priority.error }, { status: 400 });
    const changed = await setBatchPriority(
      project.id,
      params.batchId,
      current.user.id,
      priority.value,
    );
    if (!changed.ok && changed.error === 'not_found') throw notFound('Batch not found');
    return redirectWithFlash(
      request,
      here,
      changed.ok
        ? `Priority set to ${priority.value}. It counts from the next task anyone asks for.`
        : `The priority is ${priority.value} already.`,
    );
  }
  if (form.get('intent') === 'pause' || form.get('intent') === 'resume') {
    const pause = form.get('intent') === 'pause';
    const changed = await setBatchPaused(project.id, params.batchId, current.user.id, pause);
    if (!changed.ok && changed.error === 'not_found') throw notFound('Batch not found');
    if (!changed.ok) {
      return data(
        { error: pause ? 'This batch is paused already.' : 'This batch is not paused.' },
        { status: 409 },
      );
    }
    return redirectWithFlash(
      request,
      here,
      pause
        ? 'Paused. Nothing from this batch is handed out until it is resumed; tasks that are being worked on can be finished.'
        : 'Resumed. The batch is handed out again from where it was.',
    );
  }
  if (form.get('intent') !== 'delete') throw badRequest('Unknown action');
  const result = await deleteBatch(project.id, params.batchId, current.user.id);
  if (!result.ok) return data({ error: result.error }, { status: 409 });
  return redirectWithFlash(
    request,
    `/projects/${project.id}/batches`,
    `Deleted the batch and its ${result.tasks} tasks.`,
  );
}

export default function BatchDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { projectId, batch, tasks, page, status, q, openBatches, standing } = loaderData;
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
        actions={
          <Form
            method="post"
            onSubmit={(event) => {
              if (!confirm('Delete this batch and all of its tasks?')) event.preventDefault();
            }}
          >
            <Button name="intent" value="delete" variant="ghost" className="text-rose-600">
              Delete batch
            </Button>
          </Form>
        }
      />
      {actionData?.error && (
        <div className="mb-4">
          <Alert>{actionData.error}</Alert>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg bg-white px-4 py-3 text-sm shadow-sm ring-1 ring-slate-200">
        <Form method="post" className="flex items-center gap-2">
          <label htmlFor="priority" className="text-slate-600">
            Priority
          </label>
          <Input
            id="priority"
            name="priority"
            type="number"
            min={-MAX_BATCH_PRIORITY}
            max={MAX_BATCH_PRIORITY}
            defaultValue={batch.priority}
            className="w-20"
            title="Batches with a higher number are handed out first. 0 is normal."
          />
          <Button name="intent" value="priority" variant="secondary">
            Set
          </Button>
        </Form>
        <Form method="post" className="flex items-center gap-2">
          {batch.pausedAt ? (
            <>
              <Badge tone="amber">Paused since {formatDateTime(batch.pausedAt)}</Badge>
              <Button name="intent" value="resume" variant="secondary">
                Resume
              </Button>
            </>
          ) : (
            <Button name="intent" value="pause" variant="secondary">
              Pause
            </Button>
          )}
        </Form>
        <p className="text-slate-500">
          {standing.open} open task{standing.open === 1 ? '' : 's'}
          {standing.partial > 0 &&
            `, ${standing.partial} of them with some answers already${
              batch.pausedAt ? ', waiting for the rest until the batch is resumed' : ''
            }`}
          {standing.claims > 0 &&
            `; ${standing.claims} being worked on${batch.pausedAt ? ', which can be finished' : ''}`}
          .
        </p>
      </div>
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
            placeholder="Search id, text or reference"
            aria-label="Search tasks"
            className="w-56"
          />
        </Form>
      </div>
      {tasks.length === 0 ? (
        <EmptyState title="No tasks match this filter" />
      ) : (
        <Form
          method="post"
          className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200"
        >
          {tasks.some((t) => t.canBeGold) && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 text-sm text-slate-600">
              <span>
                Tick completed tasks to use them as gold. Each gets a copy with the consensus as its
                expected answer, among the open tasks of the batch you choose; the originals stay as
                they are.
              </span>
              {openBatches.length === 0 ? (
                <span className="text-slate-500">No batch has open tasks to put them among.</span>
              ) : (
                <span className="flex items-center gap-2">
                  <select
                    name="targetBatchId"
                    defaultValue={openBatches[0].id}
                    aria-label="Batch for the gold tasks"
                    className="rounded-md border-0 py-1.5 pl-2 pr-8 text-sm ring-1 ring-slate-300"
                  >
                    {openBatches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <Button name="intent" value="gold-copy" variant="secondary">
                    Use ticked as gold
                  </Button>
                </span>
              )}
            </div>
          )}
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-10 px-4 py-2">
                  <span className="sr-only">Use as gold</span>
                </th>
                <th className="w-16 px-4 py-2">#</th>
                <th className="px-4 py-2">Task</th>
                <th className="w-28 px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tasks.map((task) => (
                <tr key={task.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    {task.canBeGold && (
                      <input
                        type="checkbox"
                        name="taskId"
                        value={task.id}
                        aria-label={`Use task ${task.position} as gold`}
                      />
                    )}
                  </td>
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
                      <Badge tone="amber">{task.goldRetired ? 'Gold, retired' : 'Gold'}</Badge>
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
        </Form>
      )}
      <Pagination info={page} />
    </div>
  );
}
