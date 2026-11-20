import type { Prisma } from '@prisma/client';
import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';

import { DraftNote } from '~/components/draft-note';
import { LabelingInterface } from '~/components/labeling';
import { Alert, Button, Card } from '~/components/ui';
import { useDraftSave } from '~/components/use-draft-save';
import { parseAnswerJson, validateAnswer, type Answer } from '~/domain/answers';
import { droppedNote, fitDraft } from '~/domain/drafts';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { notFound } from '~/lib/http';
import { projectSchema } from '~/models/projects.server';
import { resubmitAssignment } from '~/models/queue.server';

import type { Route } from './+types/my-work-revise';

export function meta() {
  return [{ title: 'Revise submission · Labeling Portal' }];
}

async function loadReturned(assignmentId: string, userId: string) {
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId, userId, status: 'SUBMITTED' },
    include: {
      project: true,
      task: true,
      reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  if (!assignment) throw notFound('Submission not found');
  return assignment;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user } = await requireUser(request);
  const assignment = await loadReturned(params.assignmentId, user.id);
  if (assignment.reviewStatus !== 'SENT_BACK' && assignment.reviewStatus !== 'FIXED') {
    throw redirect('/my-work');
  }
  const fix = assignment.reviews.find((r) => r.decision === 'FIX');
  const schema = projectSchema(assignment.project);
  // changes that were under way before a reload
  const draft = fitDraft(schema, assignment.task.data, assignment.draft);
  return {
    userId: user.id,
    mode: assignment.reviewStatus === 'FIXED' ? ('compare' as const) : ('revise' as const),
    corrected: (fix?.correctedAnswer ?? null) as Answer | null,
    id: assignment.id,
    projectName: assignment.project.name,
    schema,
    data: assignment.task.data as Record<string, unknown>,
    answer: assignment.answer as Answer,
    draft: draft.answer,
    draftNote: droppedNote(schema, draft.dropped),
    feedback: assignment.reviews[0]?.feedback ?? '',
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { user } = await requireUser(request);
  const assignment = await loadReturned(params.assignmentId, user.id);
  const form = await request.formData();
  const checked = validateAnswer(
    projectSchema(assignment.project),
    assignment.task.data,
    parseAnswerJson(form.get('answer')),
  );
  if (!checked.ok) return data({ error: checked.error }, { status: 400 });
  const result = await resubmitAssignment(
    assignment.id,
    user.id,
    checked.answer as Prisma.InputJsonValue,
  );
  if (!result.ok)
    return data({ error: 'This submission is not waiting for changes.' }, { status: 409 });
  return redirect('/my-work?filter=returned');
}

/**
 * Keyed by submission, like the work page: going back and forth in the
 * browser history between two sent-back submissions stays on this route, and
 * without the key the first one's answer would be saved as the other's draft.
 */
export default function Revise(props: Route.ComponentProps) {
  return <RevisePage key={props.loaderData.id} {...props} />;
}

function RevisePage({ loaderData, actionData }: Route.ComponentProps) {
  const { projectName, schema, data: taskData, answer, feedback, mode, corrected } = loaderData;
  const [value, setValue] = useState<Answer>(loaderData.draft ?? answer);
  const navigation = useNavigation();
  // nothing is saved in compare mode: the answer there cannot change
  const draftState = useDraftSave({
    url: `/my-work/${loaderData.id}/draft`,
    user: loaderData.userId,
    answer: value,
    restored: loaderData.draft !== null,
    handingIn: navigation.formAction === `/my-work/${loaderData.id}`,
    onRecover: (unsaved) => {
      const fitted = fitDraft(schema, taskData, unsaved.draft).answer;
      if (fitted) setValue(fitted);
    },
  });

  if (mode === 'compare') {
    return (
      <div className="space-y-4">
        <Link to="/my-work" className="text-sm text-indigo-700 hover:underline">
          ← My work
        </Link>
        <h1 className="text-xl font-semibold">Reviewer correction: {projectName}</h1>
        {feedback && (
          <p className="rounded-md bg-sky-50 px-4 py-3 text-sm text-sky-900 ring-1 ring-sky-200">
            {feedback}
          </p>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Your answer
            </h2>
            <LabelingInterface
              schema={schema}
              data={taskData}
              value={answer}
              onChange={() => {}}
              readOnly
            />
          </Card>
          <Card>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Corrected
            </h2>
            <LabelingInterface
              schema={schema}
              data={taskData}
              value={corrected}
              onChange={() => {}}
              readOnly
            />
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link to="/my-work?filter=returned" className="text-sm text-indigo-700 hover:underline">
        ← My work
      </Link>
      <h1 className="text-xl font-semibold">Revise: {projectName}</h1>
      {feedback && (
        <div className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          <div className="font-medium">Reviewer feedback</div>
          <p className="mt-1 whitespace-pre-wrap">{feedback}</p>
        </div>
      )}
      {actionData?.error && <Alert>{actionData.error}</Alert>}
      {loaderData.draftNote && <Alert tone="info">{loaderData.draftNote}</Alert>}
      <Card>
        <LabelingInterface schema={schema} data={taskData} value={value} onChange={setValue} />
      </Card>
      <Form method="post" className="flex items-center gap-3">
        <input type="hidden" name="answer" value={JSON.stringify(value)} />
        <Button type="submit" disabled={navigation.state !== 'idle'}>
          Resubmit for review
        </Button>
        <DraftNote state={draftState} />
      </Form>
    </div>
  );
}
