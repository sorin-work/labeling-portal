import type { Prisma } from '@prisma/client';
import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';

import { LabelingInterface } from '~/components/labeling';
import { Alert, Button, Card } from '~/components/ui';
import { parseAnswerJson, validateAnswer, type Answer } from '~/domain/answers';
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
  return {
    mode: assignment.reviewStatus === 'FIXED' ? ('compare' as const) : ('revise' as const),
    corrected: (fix?.correctedAnswer ?? null) as Answer | null,
    id: assignment.id,
    projectName: assignment.project.name,
    schema: projectSchema(assignment.project),
    data: assignment.task.data as Record<string, unknown>,
    answer: assignment.answer as Answer,
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

export default function Revise({ loaderData, actionData }: Route.ComponentProps) {
  const { projectName, schema, data: taskData, answer, feedback, mode, corrected } = loaderData;
  const [value, setValue] = useState<Answer>(answer);
  const navigation = useNavigation();

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
      <Card>
        <LabelingInterface schema={schema} data={taskData} value={value} onChange={setValue} />
      </Card>
      <Form method="post">
        <input type="hidden" name="answer" value={JSON.stringify(value)} />
        <Button type="submit" disabled={navigation.state !== 'idle'}>
          Resubmit for review
        </Button>
      </Form>
    </div>
  );
}
