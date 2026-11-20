import { data, Form, Link, useNavigation } from 'react-router';

import { CopyButton } from '~/components/copy-button';
import { GoldPanel } from '~/components/gold-panel';
import { LabelingInterface } from '~/components/labeling';
import { Alert, Badge, Button, Card, EmptyState, PageHeader } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import { parseAnswerJson, type Answer } from '~/domain/answers';
import { formatGoldScore, parseGoldReason } from '~/domain/gold';
import { finalAnswer } from '~/domain/outcome';
import { assignmentRef } from '~/domain/reference';
import { activeHold } from '~/domain/review-hold';
import { SAMPLE_LABELS } from '~/domain/review-sampling';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { formatDateTime, REVIEW_BADGES, titleCase } from '~/lib/format';
import { redirectWithFlash } from '~/lib/flash.server';
import { badRequest, forbidden, notFound } from '~/lib/http';
import { can } from '~/lib/permissions';
import {
  applyRescore,
  editGoldAnswer,
  goldTaskView,
  openBatches,
  promoteToGold,
  setGoldRetired,
  type GoldRefusal,
} from '~/models/gold.server';
import { projectSchema, requireProject } from '~/models/projects.server';

import type { Route } from './+types/task-detail';

export function meta() {
  return [{ title: 'Task · Labeling Portal' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId);
  const role = current.membership.role;
  if (!can(role, 'manageProjects') && !can(role, 'review')) throw forbidden();

  const task = await prisma.task.findFirst({
    where: { id: params.taskId, projectId: project.id },
    include: {
      batch: { select: { id: true, name: true } },
      assignments: {
        orderBy: { claimedAt: 'asc' },
        include: {
          user: { select: { name: true } },
          reviewHeldBy: { select: { name: true } },
          reviews: {
            orderBy: { createdAt: 'asc' },
            include: { reviewer: { select: { name: true } } },
          },
        },
      },
    },
  });
  if (!task) throw notFound('Task not found');
  const now = new Date();
  // the expected answer, its history and the actions are for managers only;
  // reviewers see that a task is gold and how each answer scored, as before
  const canManage = can(role, 'manageProjects');
  const gold = canManage ? await goldTaskView(project, task.id) : null;

  return {
    projectId: project.id,
    schema: projectSchema(project),
    gold,
    // where a gold copy of this task could go: batches that still have open tasks
    openBatches: canManage ? await openBatches(project.id) : [],
    canUseAsGold:
      canManage &&
      !task.isGold &&
      !task.isQualification &&
      task.status === 'COMPLETE' &&
      task.consensus !== null,
    task: {
      id: task.id,
      externalId: task.externalId,
      position: task.position,
      status: task.status,
      isGold: task.isGold,
      goldRetired: task.goldRetiredAt !== null,
      data: task.data as Record<string, unknown>,
      consensus: task.consensus as Answer | null,
      agreement: task.agreement,
      batch: task.batch,
    },
    assignments: task.assignments.map((a) => ({
      id: a.id,
      annotator: a.user.name,
      status: a.status,
      reviewStatus: a.reviewStatus,
      // what the annotator sees on the work page and quotes when reporting a problem
      ref: assignmentRef(a.id),
      sampleNote: a.reviewSample ? SAMPLE_LABELS[a.reviewSample] : null,
      heldBy:
        a.reviewStatus === 'PENDING'
          ? (activeHold(a, current.user.id, now)?.reviewer ?? null)
          : null,
      claimedAt: a.claimedAt,
      submittedAt: a.submittedAt,
      activeSeconds: a.activeSeconds,
      goldScore: task.isGold ? a.goldScore : null,
      skipReason: a.skipReason,
      answer: a.answer ? finalAnswer<Answer>(a.answer, a.reviews) : null,
      corrected: a.reviews.some((r) => r.decision === 'FIX' && !r.overturnedAt),
      reviews: a.reviews.map((r) => ({
        id: r.id,
        reviewer: r.reviewer.name,
        decision: r.decision,
        qaScore: r.qaScore,
        feedback: r.feedback,
        overturned: r.overturnedAt !== null,
      })),
    })),
  };
}

const REFUSALS: Record<GoldRefusal['error'], string> = {
  not_found: 'Task not found.',
  not_gold: 'This task has no expected answer to change.',
  unchanged: 'That is the expected answer already.',
  already_done: 'Someone already did that.',
  another_live:
    'Another gold copy of the same task is in use. Retire that one first: a task has one gold copy at a time.',
  invalid: 'The expected answer is not valid.',
};

/** POST: what a manager does to a gold task. Everything here needs `manageProjects`. */
export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const here = `/projects/${project.id}/tasks/${params.taskId}`;
  const refuse = (refusal: GoldRefusal) => {
    if (refusal.error === 'not_found') throw notFound('Task not found');
    const message =
      refusal.error === 'invalid'
        ? `The expected answer is not valid: ${refusal.message}`
        : REFUSALS[refusal.error];
    return data({ error: message }, { status: refusal.error === 'invalid' ? 400 : 409 });
  };

  if (intent === 'gold-rescore') {
    const result = await applyRescore(
      project,
      params.taskId,
      current.user.id,
      String(form.get('digest') ?? ''),
    );
    if (!result.ok && result.error === 'stale') {
      return data(
        {
          error:
            'Nothing was rescored: the expected answer or the stored answers changed after this page was loaded. The numbers below are the current ones; press again if they are what you want.',
        },
        { status: 409 },
      );
    }
    if (!result.ok) return refuse({ error: result.error });
    const { changes, impact } = result.plan;
    return redirectWithFlash(
      request,
      here,
      changes.length === 0
        ? 'Every score was up to date already. Nothing changed.'
        : `Rescored ${changes.length} answer${changes.length === 1 ? '' : 's'}. Gold accuracy changed for ${impact.moved.length} annotator${impact.moved.length === 1 ? '' : 's'}.`,
    );
  }

  if (intent === 'gold-copy') {
    const outcome = await promoteToGold(project, [params.taskId], current.user.id, {
      batchId: String(form.get('batchId') ?? '') || null,
    });
    if (outcome.created.length === 0) {
      const why = outcome.refused ?? outcome.skipped[0]?.why ?? 'it cannot be used as gold';
      return data({ error: `This task was not copied: ${why}.` }, { status: 409 });
    }
    return redirectWithFlash(
      request,
      `/projects/${project.id}/tasks/${outcome.created[0]}`,
      'Made a gold task from the consensus. This is the copy; the original is unchanged.',
    );
  }

  const reason = parseGoldReason(form.get('reason'));
  if (!reason.ok) return data({ error: reason.error }, { status: 400 });

  if (intent === 'gold-edit') {
    const raw = form.get('gold');
    const result = await editGoldAnswer(project, params.taskId, current.user.id, {
      answer: raw ? parseAnswerJson(raw) : { preference: form.get('preference') },
      reason: reason.reason,
    });
    if (!result.ok) return refuse(result);
    return redirectWithFlash(request, here, 'Saved the expected answer. Scores were not changed.');
  }

  if (intent === 'gold-retire' || intent === 'gold-restore') {
    const retired = intent === 'gold-retire';
    const result = await setGoldRetired(project, params.taskId, current.user.id, {
      retired,
      reason: reason.reason,
    });
    if (!result.ok) return refuse(result);
    return redirectWithFlash(
      request,
      here,
      retired
        ? 'Retired. The task is no longer handed out and its scores do not count.'
        : 'Brought back. The task is in the queue again and its scores count.',
    );
  }

  throw badRequest('Unknown action');
}

export default function TaskDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { projectId, schema, task, assignments, gold, canUseAsGold, openBatches } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';
  const submitted = assignments.filter((a) => a.answer);
  const other = assignments.filter((a) => !a.answer);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span>
            Task #{task.position}
            {task.externalId && (
              <span className="ml-2 font-mono text-base text-slate-500">{task.externalId}</span>
            )}
            <span className="ml-2 align-middle">
              <CopyButton value={task.externalId ?? task.id} label="Copy id" />
            </span>
          </span>
        }
        subtitle={
          <span>
            <Link
              to={`/projects/${projectId}/batches/${task.batch.id}`}
              className="text-indigo-700 hover:underline"
            >
              {task.batch.name}
            </Link>{' '}
            ·{' '}
            <Badge tone={task.status === 'COMPLETE' ? 'emerald' : 'slate'}>
              {titleCase(task.status)}
            </Badge>
            {task.isGold && (
              <span className="ml-1">
                <Badge tone="amber">{task.goldRetired ? 'Gold, retired' : 'Gold'}</Badge>
              </span>
            )}
            {task.agreement !== null && (
              <span> · agreement {Math.round(task.agreement * 100)}%</span>
            )}
          </span>
        }
      />

      {actionData?.error && <Alert>{actionData.error}</Alert>}
      {gold && (gold.isGold || gold.isQualification) && (
        <GoldPanel
          key={task.id}
          projectId={projectId}
          schema={schema}
          data={task.data}
          gold={gold}
          busy={busy}
        />
      )}
      {canUseAsGold && gold && (
        <Card className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="text-slate-600">
            {gold.copies.length > 0 ? (
              <>
                Used as gold:{' '}
                {gold.copies.map((copy) => (
                  <Link
                    key={copy.id}
                    to={`/projects/${projectId}/tasks/${copy.id}`}
                    className="mr-2 text-indigo-700 hover:underline"
                  >
                    task #{copy.position}
                    {copy.retired && ' (retired)'}
                  </Link>
                ))}
              </>
            ) : (
              'Use this task as gold: a copy with the consensus as its expected answer goes into the queue, among the open tasks of the batch you choose. This task and its labels stay as they are.'
            )}
          </div>
          {gold.copies.every((copy) => copy.retired) &&
            (openBatches.length === 0 ? (
              <span className="text-slate-500">
                No batch has open tasks to put a gold task among.
              </span>
            ) : (
              <Form method="post" className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-slate-600">
                  Into
                  <select
                    name="batchId"
                    defaultValue={openBatches[0].id}
                    className="rounded-md border-0 py-1.5 pl-2 pr-8 text-sm ring-1 ring-slate-300"
                  >
                    {openBatches.map((batch) => (
                      <option key={batch.id} value={batch.id}>
                        {batch.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button name="intent" value="gold-copy" variant="secondary" disabled={busy}>
                  Use as gold
                </Button>
              </Form>
            ))}
        </Card>
      )}
      {task.consensus && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Consensus
          </h2>
          <LabelingInterface
            schema={schema}
            data={task.data}
            value={task.consensus}
            onChange={() => {}}
            readOnly
            viewKey={`${task.id}:consensus`}
          />
        </Card>
      )}

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Submissions
        </h2>
        {submitted.length === 0 && <EmptyState title="Nobody has submitted this task yet" />}
        {submitted.map((a) => {
          const badge = a.reviewStatus ? REVIEW_BADGES[a.reviewStatus] : null;
          return (
            <Card key={a.id}>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{a.annotator}</span>
                {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                {a.corrected && <Badge tone="sky">Showing reviewer correction</Badge>}
                {a.heldBy && <Badge tone="indigo">With {a.heldBy}</Badge>}
                {a.goldScore !== null && (
                  <Badge tone={a.goldScore >= 0.8 ? 'emerald' : 'rose'}>
                    Gold {formatGoldScore(a.goldScore)}
                  </Badge>
                )}
                <span className="text-slate-500">
                  {formatDuration(a.activeSeconds)} ·{' '}
                  {a.submittedAt ? formatDateTime(a.submittedAt) : ''}
                  {a.sampleNote && ` · ${a.sampleNote}`} · ref {a.ref}
                </span>
              </div>
              <LabelingInterface
                schema={schema}
                data={task.data}
                value={a.answer}
                onChange={() => {}}
                readOnly
                viewKey={a.id}
              />
              {a.reviews.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm text-slate-600">
                  {a.reviews.map((r) => (
                    <li key={r.id}>
                      <span className="font-medium">{r.reviewer}</span>:{' '}
                      {r.decision.replace('_', ' ').toLowerCase()}
                      {r.qaScore !== null && ` (score ${r.qaScore})`}
                      {r.feedback && ` - ${r.feedback}`}
                      {r.overturned && ' (overturned after a dispute)'}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </section>

      {other.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Claims
          </h2>
          <ul className="space-y-1 text-sm">
            {other.map((a) => (
              <li key={a.id} className="text-slate-600">
                {a.annotator}: {titleCase(a.status)} · claimed {formatDateTime(a.claimedAt)} · ref{' '}
                {a.ref}
                {a.skipReason && <span className="text-slate-500"> · “{a.skipReason}”</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="rounded-lg bg-white p-4 text-sm ring-1 ring-slate-200">
        <summary className="cursor-pointer font-medium">Raw task data</summary>
        <pre className="mt-2 overflow-x-auto text-xs">{JSON.stringify(task.data, null, 2)}</pre>
      </details>
    </div>
  );
}
