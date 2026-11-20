import { data, Form, Link, useNavigation } from 'react-router';

import { AdjudicationPanel } from '~/components/adjudication-panel';
import { CopyButton } from '~/components/copy-button';
import { GoldPanel } from '~/components/gold-panel';
import { LabelingInterface } from '~/components/labeling';
import { Alert, Badge, Button, Card, EmptyState, PageHeader } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import { consensusSource, parseAdjudicationNote } from '~/domain/adjudication';
import { parseAnswerJson, type Answer } from '~/domain/answers';
import { formatGoldScore, parseGoldReason } from '~/domain/gold';
import { finalAnswer, isAccepted } from '~/domain/outcome';
import { assignmentRef } from '~/domain/reference';
import { activeHold } from '~/domain/review-hold';
import { SAMPLE_LABELS } from '~/domain/review-sampling';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { formatDateTime, REVIEW_BADGES, TASK_STATUS_BADGES, titleCase } from '~/lib/format';
import { redirectWithFlash } from '~/lib/flash.server';
import { badRequest, notFound } from '~/lib/http';
import { can } from '~/lib/permissions';
import {
  adjudicateTask,
  labeledBy,
  sendToAdjudication,
  type AdjudicationChoice,
  type AdjudicationRefusal,
} from '~/models/adjudication.server';
import {
  applyRescore,
  editGoldAnswer,
  goldTaskView,
  openBatches,
  promoteToGold,
  setGoldRetired,
  type GoldRefusal,
} from '~/models/gold.server';
import { projectSchema, requireProject, requireTaskViewer } from '~/models/projects.server';

import type { Route } from './+types/task-detail';

export function meta() {
  return [{ title: 'Task · Labeling Portal' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireTaskViewer(current, params.projectId);
  const role = current.membership.role;

  const task = await prisma.task.findFirst({
    where: { id: params.taskId, projectId: project.id },
    include: {
      batch: { select: { id: true, name: true } },
      adjudicatedBy: { select: { name: true } },
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
  // who had a hand in the answers (or in those of the same item's gold copies) cannot settle it
  const labeled =
    task.status === 'ADJUDICATION' ? await labeledBy(prisma, task.id, current.user.id) : false;
  const adjudication =
    task.status === 'ADJUDICATION'
      ? {
          threshold: project.agreementThreshold,
          extraSlots: task.extraSlots,
          choices: task.assignments
            .filter((a) => a.status === 'SUBMITTED' && isAccepted(a.reviewStatus))
            .map((a) => ({ assignmentId: a.id, annotator: a.user.name })),
          hasConsensus: task.majority !== null,
          refusal: !can(role, 'review')
            ? 'Reviewers settle tasks in adjudication.'
            : labeled
              ? 'You labeled or corrected an answer of this task, so someone else has to settle it.'
              : null,
        }
      : null;

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
    adjudication,
    // a task that waits for an extra annotator nobody may be left to be
    canEscalate: canManage && task.status === 'OPEN' && task.extraSlots > 0,
    task: {
      id: task.id,
      externalId: task.externalId,
      position: task.position,
      status: task.status,
      isGold: task.isGold,
      goldRetired: task.goldRetiredAt !== null,
      data: task.data as Record<string, unknown>,
      consensus: task.consensus as Answer | null,
      // while it waits for adjudication: what the majority says, not a result
      majority: task.majority as Answer | null,
      agreement: task.agreement,
      extraSlots: task.extraSlots,
      source: consensusSource(task),
      adjudicated: task.adjudicatedAt
        ? {
            by: task.adjudicatedBy?.name ?? 'Someone',
            at: task.adjudicatedAt,
            note: task.adjudicatedNote ?? '',
          }
        : null,
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

const ADJUDICATION_REFUSALS: Record<Exclude<AdjudicationRefusal['error'], 'invalid'>, string> = {
  not_found: 'Task not found.',
  not_waiting: 'This task is not waiting for adjudication any more.',
  own_work: 'You labeled or corrected an answer of this task, so someone else has to settle it.',
  no_consensus: 'The answers have no consensus to keep.',
  no_submission: 'That answer is not one of the accepted answers of this task.',
};

/**
 * POST: settling a task in adjudication needs `review`; everything else here
 * (gold tasks, sending a task to adjudication) needs `manageProjects`.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const project = await requireProject(
    current,
    params.projectId,
    intent === 'adjudicate' ? 'review' : 'manageProjects',
  );
  const here = `/projects/${project.id}/tasks/${params.taskId}`;

  if (intent === 'adjudicate') {
    const note = parseAdjudicationNote(form.get('note'));
    if (!note.ok) return data({ error: note.error }, { status: 400 });
    const kind = String(form.get('kind') ?? '');
    let choice: AdjudicationChoice;
    if (kind === 'consensus') choice = { kind };
    else if (kind === 'submission') {
      choice = { kind, assignmentId: String(form.get('assignmentId') ?? '') };
    } else if (kind === 'own') choice = { kind, answer: parseAnswerJson(form.get('answer')) };
    else throw badRequest('Choose how to settle the task');
    const result = await adjudicateTask(
      project,
      params.taskId,
      current.user.id,
      choice,
      note.value,
    );
    if (!result.ok) {
      if (result.error === 'not_found') throw notFound('Task not found');
      if (result.error === 'invalid') {
        return data({ error: `The answer is not valid: ${result.message}` }, { status: 400 });
      }
      return data(
        { error: ADJUDICATION_REFUSALS[result.error] },
        { status: result.error === 'own_work' ? 403 : 409 },
      );
    }
    return redirectWithFlash(
      request,
      here,
      'Settled. The chosen answer is the result of this task.',
    );
  }

  if (intent === 'escalate') {
    const result = await sendToAdjudication(project, params.taskId, current.user.id);
    if (!result.ok && result.error === 'not_found') throw notFound('Task not found');
    if (!result.ok) {
      return data(
        { error: 'Only a task that waits for an extra annotator can be sent to adjudication.' },
        { status: 409 },
      );
    }
    return redirectWithFlash(request, here, 'Sent to adjudication.');
  }
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
  const {
    projectId,
    schema,
    task,
    assignments,
    gold,
    canUseAsGold,
    openBatches,
    adjudication,
    canEscalate,
  } = loaderData;
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
            <Badge tone={TASK_STATUS_BADGES[task.status].tone}>
              {TASK_STATUS_BADGES[task.status].label}
            </Badge>
            {task.source === 'adjudicated' && (
              <span className="ml-1">
                <Badge tone="sky">Adjudicated</Badge>
              </span>
            )}
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
      {adjudication && (
        <AdjudicationPanel
          key={task.id}
          schema={schema}
          data={task.data}
          view={adjudication}
          busy={busy}
        />
      )}
      {canEscalate && (
        <Card className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-slate-600">
            The answers agreed too little, so this task waits for{' '}
            {task.extraSlots === 1 ? 'an extra annotator' : 'extra annotators'}. When nobody is left
            who could take it, send it to adjudication now.
          </p>
          <Form method="post">
            <Button name="intent" value="escalate" variant="secondary" disabled={busy}>
              Send to adjudication
            </Button>
          </Form>
        </Card>
      )}
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
      {(task.consensus ?? task.majority) && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            {task.consensus ? 'Consensus' : 'What the majority says (not a result yet)'}
          </h2>
          {task.adjudicated && (
            <p className="mb-3 text-sm text-slate-600">
              Adjudicated by {task.adjudicated.by} on {formatDateTime(task.adjudicated.at)}: “
              {task.adjudicated.note}”
            </p>
          )}
          <LabelingInterface
            schema={schema}
            data={task.data}
            value={task.consensus ?? task.majority}
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
