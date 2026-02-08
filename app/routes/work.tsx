import type { Prisma } from '@prisma/client';
import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';

import { Countdown } from '~/components/countdown';
import { formatDuration, useActiveTime } from '~/components/use-active-time';
import { LabelingInterface } from '~/components/labeling';
import { MarkdownBody } from '~/components/markdown';
import { Alert, Button, Card } from '~/components/ui';
import { parseAnswerJson, validateAnswer, type Answer } from '~/domain/answers';
import { renderMarkdown } from '~/domain/markdown';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { notFound } from '~/lib/http';
import { projectSchema } from '~/models/projects.server';
import {
  claimNextTask,
  releaseAssignment,
  releaseExpiredClaims,
  skipAssignment,
  submitAssignment,
} from '~/models/queue.server';

import type { Route } from './+types/work';

export const SKIP_REASONS = [
  'Instructions do not cover this case',
  'Content is broken or unreadable',
  'Content is offensive or disturbing',
  'Not in a language I can label',
  'Other',
];

export function meta() {
  return [{ title: 'Labeling · Labeling Portal' }];
}

async function loadOwnAssignment(assignmentId: string, userId: string) {
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId, userId },
    include: { task: true, project: true },
  });
  if (!assignment) throw notFound('Task not found');
  return assignment;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user } = await requireUser(request);
  const assignment = await loadOwnAssignment(params.assignmentId, user.id);
  if (assignment.status === 'ACTIVE' && assignment.expiresAt <= new Date()) {
    await releaseExpiredClaims(assignment.projectId);
    throw redirect(`/projects/${assignment.projectId}?queue=expired`);
  }
  if (assignment.status !== 'ACTIVE') {
    throw redirect(`/projects/${assignment.projectId}`);
  }
  const { project, task } = assignment;
  return {
    assignment: {
      id: assignment.id,
      claimedAt: assignment.claimedAt.toISOString(),
      expiresAt: assignment.expiresAt.toISOString(),
    },
    project: { id: project.id, name: project.name },
    instructionsHtml: renderMarkdown(project.instructions),
    schema: projectSchema(project),
    task: {
      id: task.id,
      externalId: task.externalId,
      data: task.data as Record<string, unknown>,
    },
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { user } = await requireUser(request);
  const assignment = await loadOwnAssignment(params.assignmentId, user.id);
  const form = await request.formData();
  const intent = form.get('intent');

  if (intent === 'release') {
    await releaseAssignment(assignment.id, user.id);
    return redirect(`/projects/${assignment.projectId}`);
  }

  if (intent === 'skip') {
    const choice = String(form.get('reason') ?? '');
    const detail = String(form.get('detail') ?? '').trim();
    if (!SKIP_REASONS.includes(choice)) {
      return data({ error: 'Pick a reason for skipping.' }, { status: 400 });
    }
    if (choice === 'Other' && !detail) {
      return data({ error: 'Tell us why you are skipping this task.' }, { status: 400 });
    }
    const reason = detail ? `${choice}: ${detail.slice(0, 500)}` : choice;
    const result = await skipAssignment(assignment.id, user.id, reason);
    if (!result.ok) return data({ error: 'This task is no longer yours.' }, { status: 409 });
  } else {
    const schema = projectSchema(assignment.project);
    const checked = validateAnswer(
      schema,
      assignment.task.data,
      parseAnswerJson(form.get('answer')),
    );
    if (!checked.ok) return data({ error: checked.error }, { status: 400 });
    const result = await submitAssignment(assignment.id, user.id, {
      answer: checked.answer as Prisma.InputJsonValue,
      activeSeconds: Number(form.get('activeSeconds') ?? 0),
      reviewRequired: assignment.project.reviewRequired,
    });
    if (!result.ok) return data({ error: 'This task is no longer yours.' }, { status: 409 });
  }

  const next = await claimNextTask(assignment.project, user.id);
  if (!next.ok) return redirect(`/projects/${assignment.projectId}?queue=${next.reason}`);
  return redirect(`/work/${next.assignment.id}`);
}

export default function Work({ loaderData, actionData }: Route.ComponentProps) {
  const { assignment, project, schema, task, instructionsHtml } = loaderData;
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [skipping, setSkipping] = useState(false);
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';
  const activeSeconds = useActiveTime();

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Link
              to={`/projects/${project.id}`}
              className="text-sm text-indigo-700 hover:underline"
            >
              {project.name}
            </Link>
            {task.externalId && (
              <span className="ml-2 font-mono text-xs text-slate-400">{task.externalId}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span
              className="text-xs text-slate-500"
              title="Time you have actively worked on this task"
            >
              Working time {formatDuration(activeSeconds)}
            </span>
            <Countdown expiresAt={assignment.expiresAt} />
          </div>
        </div>
        {actionData?.error && <Alert>{actionData.error}</Alert>}
        <Card>
          <LabelingInterface
            key={task.id}
            schema={schema}
            data={task.data}
            value={answer}
            onChange={setAnswer}
          />
        </Card>
        <Form method="post" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="answer" value={answer ? JSON.stringify(answer) : ''} />
          <input type="hidden" name="activeSeconds" value={activeSeconds} />
          <Button type="submit" name="intent" value="submit" disabled={busy || !answer}>
            Submit and next
          </Button>
          <Button type="button" variant="secondary" onClick={() => setSkipping((s) => !s)}>
            Skip…
          </Button>
          <Button
            type="submit"
            name="intent"
            value="release"
            variant="ghost"
            formNoValidate
            disabled={busy}
            title="Stop for now and give the task back to the queue"
          >
            Stop and release
          </Button>
        </Form>
        {skipping && (
          <Form method="post" className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200">
            <fieldset className="space-y-1">
              <legend className="mb-1 text-sm font-medium">Why are you skipping this task?</legend>
              {SKIP_REASONS.map((reason, i) => (
                <label key={reason} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="reason" value={reason} defaultChecked={i === 0} />
                  {reason}
                </label>
              ))}
            </fieldset>
            <textarea
              name="detail"
              rows={2}
              placeholder="Details (required for Other)"
              className="block w-full rounded-md px-3 py-2 text-sm ring-1 ring-slate-300"
            />
            <Button type="submit" name="intent" value="skip" variant="secondary" disabled={busy}>
              Skip task
            </Button>
          </Form>
        )}
      </div>
      <aside>
        <Card className="max-h-[70vh] overflow-y-auto">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Instructions
          </h2>
          {instructionsHtml ? (
            <MarkdownBody html={instructionsHtml} />
          ) : (
            <p className="text-sm text-slate-500">No instructions for this project.</p>
          )}
        </Card>
      </aside>
    </div>
  );
}
