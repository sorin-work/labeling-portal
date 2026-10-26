import type { Prisma } from '@prisma/client';
import { useRef, useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';

import { LabelingInterface } from '~/components/labeling';
import { useHotkeys } from '~/components/labeling/use-hotkeys';
import { Alert, Button, Card, cx } from '~/components/ui';
import { formatDuration } from '~/components/use-active-time';
import { parseAnswerJson, validateAnswer, type Answer } from '~/domain/answers';
import { parseReviewForm } from '~/domain/review-form';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { formatDateTime, formatRelative } from '~/lib/format';
import { forbidden, notFound } from '~/lib/http';
import { projectSchema, requireProject } from '~/models/projects.server';
import { nextPendingReview, recordReview } from '~/models/reviews.server';

import type { Route } from './+types/review';

export function meta() {
  return [{ title: 'Review submission · Labeling Portal' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const assignment = await prisma.assignment.findUnique({
    where: { id: params.assignmentId },
    include: {
      task: true,
      user: { select: { name: true } },
      reviews: {
        orderBy: { createdAt: 'desc' },
        include: { reviewer: { select: { name: true } } },
      },
    },
  });
  if (!assignment || assignment.status !== 'SUBMITTED') throw notFound('Submission not found');
  const project = await requireProject(current, assignment.projectId, 'review');

  return {
    project: { id: project.id, name: project.name },
    schema: projectSchema(project),
    ownWork: assignment.userId === current.user.id,
    assignment: {
      id: assignment.id,
      annotator: assignment.user.name,
      submittedAt: assignment.submittedAt,
      activeSeconds: assignment.activeSeconds,
      reviewStatus: assignment.reviewStatus,
      answer: assignment.answer as Answer,
    },
    task: {
      id: assignment.task.id,
      externalId: assignment.task.externalId,
      data: assignment.task.data as Record<string, unknown>,
    },
    history: assignment.reviews.map((r) => ({
      id: r.id,
      reviewer: r.reviewer.name,
      decision: r.decision,
      qaScore: r.qaScore,
      feedback: r.feedback,
      createdAt: r.createdAt,
    })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  const assignment = await prisma.assignment.findUnique({ where: { id: params.assignmentId } });
  if (!assignment || assignment.status !== 'SUBMITTED') throw notFound('Submission not found');
  const project = await requireProject(current, assignment.projectId, 'review');
  if (assignment.userId === current.user.id) {
    throw forbidden('You cannot review your own submission.');
  }
  if (assignment.reviewStatus !== 'PENDING') {
    return data({ error: 'Someone already reviewed this submission.' }, { status: 409 });
  }

  const form = await request.formData();
  const parsed = parseReviewForm(form);
  if (!parsed.ok) return data({ error: parsed.error }, { status: 400 });

  let correctedAnswer: Prisma.InputJsonValue | undefined;
  if (parsed.value.decision === 'FIX') {
    const task = await prisma.task.findUniqueOrThrow({ where: { id: assignment.taskId } });
    const checked = validateAnswer(
      projectSchema(project),
      task.data,
      parseAnswerJson(form.get('corrected')),
    );
    if (!checked.ok)
      return data({ error: `Your correction is not valid: ${checked.error}` }, { status: 400 });
    correctedAnswer = checked.answer as Prisma.InputJsonValue;
  }

  await recordReview(assignment.id, current.user.id, { ...parsed.value, correctedAnswer });
  const next = await nextPendingReview(assignment.projectId, current.user.id);
  return redirect(next ? `/review/${next.id}` : `/projects/${assignment.projectId}/review?done=1`);
}

const DECISION_STYLE: Record<string, string> = {
  APPROVE: 'text-emerald-700',
  SEND_BACK: 'text-amber-700',
  FIX: 'text-sky-700',
};

export default function Review({ loaderData, actionData }: Route.ComponentProps) {
  const { project, schema, assignment, task, history, ownWork } = loaderData;
  const [score, setScore] = useState<number | null>(null);
  const [fixing, setFixing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [corrected, setCorrected] = useState<Answer>(assignment.answer);
  const navigation = useNavigation();
  const approveRef = useRef<HTMLButtonElement>(null);

  // 1-5 sets the quality score, "a" approves; only while not editing a fix
  useHotkeys((key) => {
    if (fixing) return false;
    if (/^[1-5]$/.test(key)) {
      setScore(Number(key));
      return true;
    }
    if (key === 'a') {
      approveRef.current?.click();
      return true;
    }
    return false;
  });
  const pending = assignment.reviewStatus === 'PENDING';

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <Link to={`/projects/${project.id}/review`} className="text-indigo-700 hover:underline">
            ← {project.name} review queue
          </Link>
          <Link
            to={`/projects/${project.id}/tasks/${task.id}`}
            className="text-slate-500 hover:text-slate-800"
          >
            All submissions for this task
          </Link>
          <span className="text-slate-500">
            {assignment.annotator} · {formatDuration(assignment.activeSeconds)} ·{' '}
            {assignment.submittedAt ? formatDateTime(assignment.submittedAt) : ''}
            {task.externalId && <span className="ml-2 font-mono">{task.externalId}</span>}
          </span>
        </div>
        {actionData?.error && <Alert>{actionData.error}</Alert>}
        <Card>
          {fixing && (
            <p className="mb-3 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800">
              You are editing a copy of the annotation. The annotator&apos;s original is kept.
            </p>
          )}
          <LabelingInterface
            key={fixing ? 'fix' : 'view'}
            schema={schema}
            data={task.data}
            value={fixing ? corrected : assignment.answer}
            onChange={setCorrected}
            readOnly={!fixing}
          />
        </Card>
      </div>
      <aside className="space-y-4">
        {ownWork ? (
          <Alert tone="info">This is your own submission, so someone else has to review it.</Alert>
        ) : pending ? (
          <Form
            method="post"
            className="space-y-3 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200"
          >
            <fieldset>
              <legend className="mb-1 text-sm font-medium">
                Quality score <span className="font-normal text-slate-400">(keys 1-5)</span>
              </legend>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setScore(n)}
                    aria-pressed={score === n}
                    className={cx(
                      'h-8 w-8 rounded text-sm ring-1',
                      score === n ? 'bg-indigo-600 text-white ring-indigo-600' : 'ring-slate-300',
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <input type="hidden" name="qaScore" value={score ?? ''} />
              <input
                type="hidden"
                name="corrected"
                value={fixing ? JSON.stringify(corrected) : ''}
              />
            </fieldset>
            <label className="block text-sm font-medium">
              Feedback for the annotator
              <textarea
                name="feedback"
                rows={4}
                maxLength={2000}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                className="mt-1 block w-full rounded-md px-3 py-2 text-sm font-normal ring-1 ring-slate-300"
                placeholder="Required when sending work back"
              />
              <span className="mt-0.5 block text-right text-xs font-normal text-slate-400">
                {feedback.length} / 2000
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              {fixing ? (
                <>
                  <Button name="intent" value="fix" disabled={navigation.state !== 'idle'}>
                    Save fix
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setFixing(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    ref={approveRef}
                    name="intent"
                    value="approve"
                    title="Shortcut: a"
                    disabled={navigation.state !== 'idle'}
                  >
                    Approve
                  </Button>
                  <Button
                    name="intent"
                    value="send_back"
                    variant="secondary"
                    disabled={navigation.state !== 'idle'}
                  >
                    Send back
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setFixing(true)}>
                    Fix it myself
                  </Button>
                </>
              )}
            </div>
          </Form>
        ) : (
          <Alert tone="info">Already reviewed.</Alert>
        )}
        {history.length > 0 && (
          <Card>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              History
            </h2>
            <ul className="space-y-3 text-sm">
              {history.map((h) => (
                <li key={h.id}>
                  <div>
                    <span className={cx('font-medium', DECISION_STYLE[h.decision])}>
                      {h.decision.replace('_', ' ').toLowerCase()}
                    </span>{' '}
                    by {h.reviewer}
                    {h.qaScore !== null && (
                      <span className="text-slate-500"> · score {h.qaScore}</span>
                    )}
                  </div>
                  {h.feedback && (
                    <p className="mt-0.5 whitespace-pre-wrap text-slate-600">{h.feedback}</p>
                  )}
                  <div
                    className="text-xs text-slate-400"
                    title={formatDateTime(h.createdAt)}
                    suppressHydrationWarning
                  >
                    {formatRelative(h.createdAt)}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </aside>
    </div>
  );
}
