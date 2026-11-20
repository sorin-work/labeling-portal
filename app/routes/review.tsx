import type { Prisma } from '@prisma/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { data, Form, Link, redirect, useFetcher, useNavigation } from 'react-router';

import { LabelingInterface } from '~/components/labeling';
import { KeyboardHelp } from '~/components/keyboard-help';
import { useHotkeyPage, usePageHotkeys } from '~/components/labeling/use-hotkeys';
import { Alert, Button, Card, cx } from '~/components/ui';
import { formatDuration, useLastInput } from '~/components/use-active-time';
import { parseAnswerJson, validateAnswer, type Answer } from '~/domain/answers';
import { pageShortcut } from '~/domain/hotkeys';
import { parseReviewForm } from '~/domain/review-form';
import {
  activeHold,
  HOLD_RENEW_MINUTES,
  REVIEW_HOLD_MINUTES,
  shouldRenewHold,
} from '~/domain/review-hold';
import { SAMPLE_LABELS } from '~/domain/review-sampling';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { formatDateTime, formatRelative } from '~/lib/format';
import { forbidden, notFound } from '~/lib/http';
import { projectSchema, requireProject } from '~/models/projects.server';
import {
  holdReview,
  recordReview,
  renewReviewHold,
  reserveNextReview,
  type ReviewRefusal,
} from '~/models/reviews.server';

import type { Route } from './+types/review';

export function meta() {
  return [{ title: 'Review submission · Labeling Portal' }];
}

const REFUSED: Record<ReviewRefusal, string> = {
  not_pending: 'Someone already reviewed this submission.',
  held: `Another reviewer has reserved this submission. It frees up if they do not decide within ${REVIEW_HOLD_MINUTES} minutes.`,
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const assignment = await prisma.assignment.findUnique({
    where: { id: params.assignmentId },
    include: {
      task: true,
      user: { select: { name: true } },
      reviewHeldBy: { select: { name: true } },
      reviews: {
        orderBy: { createdAt: 'desc' },
        include: { reviewer: { select: { name: true } } },
      },
    },
  });
  if (!assignment || assignment.status !== 'SUBMITTED') throw notFound('Submission not found');
  const project = await requireProject(current, assignment.projectId, 'review');
  const hold = activeHold(assignment, current.user.id, new Date());

  return {
    project: { id: project.id, name: project.name },
    schema: projectSchema(project),
    ownWork: assignment.userId === current.user.id,
    hold: hold && { reviewer: hold.reviewer, mine: hold.mine, until: hold.until },
    sampleNote: assignment.reviewSample ? SAMPLE_LABELS[assignment.reviewSample] : null,
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
    return data({ error: REFUSED.not_pending }, { status: 409 });
  }

  const form = await request.formData();
  if (form.get('intent') === 'hold') {
    const held = await holdReview(assignment.id, current.user.id);
    if (!held.ok) return data({ error: REFUSED[held.error] }, { status: 409 });
    return redirect(`/review/${assignment.id}`);
  }
  // The page posts this while the reviewer is working. When the hold is no
  // longer theirs the page reloads its data and shows who has it now.
  if (form.get('intent') === 'renew') {
    const renewed = await renewReviewHold(assignment.id, current.user.id);
    return data({ error: null }, { status: renewed ? 200 : 409 });
  }

  // a decision that does not validate below still shows the reviewer is at
  // work, so their hold starts over; a stored decision clears it
  await renewReviewHold(assignment.id, current.user.id);
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

  const recorded = await recordReview(assignment.id, current.user.id, {
    ...parsed.value,
    correctedAnswer,
  });
  if (!recorded.ok) return data({ error: REFUSED[recorded.error] }, { status: 409 });
  const next = await reserveNextReview(assignment.projectId, current.user.id);
  return redirect(next ? `/review/${next.id}` : `/projects/${assignment.projectId}/review?done=1`);
}

const DECISION_STYLE: Record<string, string> = {
  APPROVE: 'text-emerald-700',
  SEND_BACK: 'text-amber-700',
  FIX: 'text-sky-700',
};

/**
 * Keeps the reviewer's hold alive while they work on the page, and returns a
 * function that renews it at once (starting a fix is the long case).
 */
function useHoldRenewal(holding: boolean) {
  const fetcher = useFetcher();
  const lastInput = useLastInput();
  // the timer below must not start over on every render, so it goes through a
  // ref to whatever the fetcher's submit currently is
  const submit = useRef(fetcher.submit);
  useEffect(() => {
    submit.current = fetcher.submit;
  });
  const renew = useCallback(() => submit.current({ intent: 'renew' }, { method: 'post' }), []);

  useEffect(() => {
    if (!holding) return;
    const timer = window.setInterval(() => {
      const page = {
        visible: document.visibilityState === 'visible',
        lastInputAt: lastInput.current,
      };
      if (shouldRenewHold(page, Date.now())) renew();
    }, HOLD_RENEW_MINUTES * 60_000);
    return () => window.clearInterval(timer);
  }, [holding, lastInput, renew]);

  return renew;
}

/**
 * Approving, sending back or fixing moves on to the next submission without
 * leaving this route, so React would keep the page's state. The key makes the
 * score, the feedback and the fix start fresh for every submission.
 */
export default function Review(props: Route.ComponentProps) {
  return <ReviewPage key={props.loaderData.assignment.id} {...props} />;
}

function ReviewPage({ loaderData, actionData }: Route.ComponentProps) {
  const { project, schema, assignment, task, history, ownWork, hold, sampleNote } = loaderData;
  const [score, setScore] = useState<number | null>(null);
  const [fixing, setFixing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [corrected, setCorrected] = useState<Answer>(assignment.answer);
  const navigation = useNavigation();
  const approveRef = useRef<HTMLButtonElement>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const pending = assignment.reviewStatus === 'PENDING';
  // the decision form is only there for the reviewer who holds the submission
  const deciding = pending && !ownWork && hold?.mine === true;
  const renewHold = useHoldRenewal(deciding);
  const startFix = () => {
    setFixing(true);
    renewHold();
  };

  // The keys of this page are rows of the key map (domain/hotkeys.ts). While
  // looking, "a" approves and the digits score; while fixing they belong to
  // the labeling interface.
  useHotkeyPage(deciding ? 'review' : null, fixing ? 'fixing' : 'viewing');
  usePageHotkeys((action, key) => {
    if (!deciding) return false;
    if (action === 'score') setScore(Number(key));
    else if (action === 'approve') approveRef.current?.click();
    else if (action === 'feedback') feedbackRef.current?.focus();
    else if (action === 'fix') startFix();
    else if (action === 'cancelFix') setFixing(false);
    else return false;
    return true;
  });

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
          <KeyboardHelp page="review" schema={schema} />
        </div>
        {actionData?.error && <Alert>{actionData.error}</Alert>}
        {sampleNote && <p className="text-sm text-slate-500">{sampleNote}.</p>}
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
        ) : !pending ? (
          <Alert tone="info">Already reviewed.</Alert>
        ) : hold && !hold.mine ? (
          <Alert tone="info">
            {hold.reviewer} is reviewing this submission. It frees up at{' '}
            {formatDateTime(hold.until)} if they do not decide.
          </Alert>
        ) : !hold ? (
          <Form
            method="post"
            className="space-y-3 rounded-lg bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200"
          >
            <p className="text-slate-600">
              Nobody is reviewing this submission. Reserve it so no other reviewer picks it up while
              you look at it.
            </p>
            <Button name="intent" value="hold" disabled={navigation.state !== 'idle'}>
              Review this submission
            </Button>
          </Form>
        ) : (
          <Form
            method="post"
            className="space-y-3 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200"
          >
            <p className="text-xs text-slate-500">
              Reserved for you until {formatDateTime(hold.until)}, and for longer while you keep
              working on it.
            </p>
            <fieldset>
              <legend className="mb-1 text-sm font-medium">
                Quality score{' '}
                <span className="font-normal text-slate-400">
                  (keys {pageShortcut('review', 'score')})
                </span>
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
                ref={feedbackRef}
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
                  <Button
                    type="button"
                    variant="ghost"
                    title={`Shortcut: ${pageShortcut('review', 'cancelFix')}`}
                    onClick={() => setFixing(false)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    ref={approveRef}
                    name="intent"
                    value="approve"
                    title={`Shortcut: ${pageShortcut('review', 'approve')}`}
                    disabled={navigation.state !== 'idle'}
                  >
                    Approve
                  </Button>
                  <Button
                    name="intent"
                    value="send_back"
                    variant="secondary"
                    title={`${pageShortcut('review', 'feedback')} goes to the feedback box`}
                    disabled={navigation.state !== 'idle'}
                  >
                    Send back
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    title={`Shortcut: ${pageShortcut('review', 'fix')}`}
                    onClick={startFix}
                  >
                    Fix it myself
                  </Button>
                </>
              )}
            </div>
          </Form>
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
