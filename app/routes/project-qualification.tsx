import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';

import { LabelingInterface } from '~/components/labeling';
import { Alert, Button, Card, EmptyState, PageHeader } from '~/components/ui';
import type { Answer } from '~/domain/answers';
import { requireUser } from '~/lib/auth.server';
import { forbidden } from '~/lib/http';
import { can } from '~/lib/permissions';
import { projectSchema, requireProject } from '~/models/projects.server';
import {
  qualificationStatus,
  qualificationTasks,
  submitQualification,
} from '~/models/qualification.server';

import type { Route } from './+types/project-qualification';

export function meta() {
  return [{ title: 'Qualification test · Labeling Portal' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  if (!can(current.membership.role, 'annotate')) throw forbidden();
  const project = await requireProject(current, params.projectId);
  const status = await qualificationStatus(project, current.user.id);
  const tasks =
    status.qualified || status.attemptsLeft === 0 ? [] : await qualificationTasks(project.id);
  const result = new URL(request.url).searchParams.get('result');
  return {
    project: { id: project.id, name: project.name },
    schema: projectSchema(project),
    status,
    justFailed: result === 'failed',
    // never send gold answers to the browser
    tasks: tasks.map((t) => ({ id: t.id, data: t.data as Record<string, unknown> })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  if (!can(current.membership.role, 'annotate')) throw forbidden();
  const project = await requireProject(current, params.projectId);
  const form = await request.formData();
  let answers: Record<string, unknown> = {};
  try {
    answers = JSON.parse(String(form.get('answers') ?? '{}'));
  } catch {
    return data({ error: 'Your answers could not be read. Please try again.' }, { status: 400 });
  }
  const outcome = await submitQualification(project, current.user.id, answers);
  if (!outcome.ok) return data({ error: outcome.error }, { status: 400 });
  return redirect(
    outcome.passed
      ? `/projects/${project.id}?queue=qualified`
      : `/projects/${project.id}/qualification?result=failed`,
  );
}

export default function Qualification({ loaderData, actionData }: Route.ComponentProps) {
  const { project, schema, status, tasks, justFailed } = loaderData;
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const navigation = useNavigation();
  const answered = tasks.filter((t) => answers[t.id]).length;

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Qualification test"
        subtitle={`${project.name} · pass mark ${status.passPercent}% · ${status.attemptsLeft} attempt${status.attemptsLeft === 1 ? '' : 's'} left`}
      />
      {justFailed && status.lastScore !== null && (
        <Alert>
          You scored {status.lastScore}%, which is below the pass mark. Re-read the instructions
          before trying again.
        </Alert>
      )}
      {actionData?.error && <Alert>{actionData.error}</Alert>}
      {status.qualified ? (
        <Alert tone="success">
          You are qualified for this project.{' '}
          <Link to={`/projects/${project.id}`} className="underline">
            Back to the project
          </Link>
        </Alert>
      ) : status.attemptsLeft === 0 ? (
        <EmptyState title="No attempts left">
          Ask a project manager if you think you should get another try.
        </EmptyState>
      ) : tasks.length === 0 ? (
        <EmptyState title="The test is not ready yet">
          A project manager still has to add the test questions.
        </EmptyState>
      ) : (
        <>
          {tasks.map((task, i) => (
            <Card key={task.id}>
              <div className="mb-3 text-sm font-medium text-slate-500">
                Question {i + 1} of {tasks.length}
              </div>
              <LabelingInterface
                schema={schema}
                data={task.data}
                value={answers[task.id] ?? null}
                onChange={(value) => setAnswers((prev) => ({ ...prev, [task.id]: value }))}
              />
            </Card>
          ))}
          <Form method="post" className="flex items-center gap-3">
            <input type="hidden" name="answers" value={JSON.stringify(answers)} />
            <Button type="submit" disabled={answered < tasks.length || navigation.state !== 'idle'}>
              Submit test
            </Button>
            <span className="text-sm text-slate-500">
              {answered} of {tasks.length} answered
            </span>
          </Form>
        </>
      )}
    </div>
  );
}
