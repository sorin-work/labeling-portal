import { useEffect, useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';

import { LabelingInterface } from '~/components/labeling';
import { MarkdownBody } from '~/components/markdown';
import { Alert, Button, Card, EmptyState, PageHeader } from '~/components/ui';
import { emptyAnswer, type Answer, type ImageSize } from '~/domain/answers';
import { packTestAnswers, restoreTestAnswers, testAnswersKey } from '~/domain/drafts';
import { renderMarkdown } from '~/domain/markdown';
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
    userId: current.user.id,
    project: { id: project.id, name: project.name },
    schema: projectSchema(project),
    status,
    justFailed: result === 'failed',
    instructionsHtml: renderMarkdown(project.instructions),
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

/**
 * A question counts as answered once something was marked. Where nothing to
 * mark is a possible answer (entities, boxes), it has to be said explicitly,
 * so an untouched question is not handed in by accident.
 */
function NothingToLabel({
  shown,
  empty,
  onPick,
}: {
  shown: boolean;
  empty: Answer | null;
  onPick: (value: Answer) => void;
}) {
  if (!shown || !empty) return null;
  return (
    <Button type="button" variant="secondary" className="mt-3" onClick={() => onPick(empty)}>
      Nothing to label here
    </Button>
  );
}

export default function Qualification({ loaderData, actionData }: Route.ComponentProps) {
  const { project, schema, status, tasks, justFailed, instructionsHtml } = loaderData;
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  // image sizes of box questions, needed to answer "nothing in this image"
  const [sizes, setSizes] = useState<Record<string, ImageSize>>({});
  const navigation = useNavigation();

  // The test has no row to keep a draft on, so the answers so far stay in this
  // browser tab, under the user and the attempt they belong to. They come back
  // after hydration, like the choices `useRemembered` keeps. Handing the test
  // in removes them, and so does signing out.
  const { userId } = loaderData;
  const storageKey = testAnswersKey(userId, project.id);
  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(storageKey);
      const owner = { user: userId, attempt: status.attempts };
      const restored = restoreTestAnswers(schema, tasks, owner, stored);
      if (Object.keys(restored).length > 0) setAnswers(restored);
    } catch {
      // storage can be disabled; the test still works without it
    }
  }, [storageKey, userId, schema, tasks, status.attempts]);

  // `actionData` is here so that a test that came back with an error is kept again
  useEffect(() => {
    if (Object.keys(answers).length === 0) return;
    try {
      const owner = { user: userId, attempt: status.attempts };
      window.sessionStorage.setItem(storageKey, packTestAnswers(owner, answers));
    } catch {
      // ignore
    }
  }, [storageKey, userId, status.attempts, answers, actionData]);

  const forget = () => {
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  };

  const answered = tasks.filter((t) => answers[t.id]).length;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
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
                  onImageSize={(size) => setSizes((prev) => ({ ...prev, [task.id]: size }))}
                />
                <NothingToLabel
                  shown={!answers[task.id]}
                  empty={emptyAnswer(schema, sizes[task.id])}
                  onPick={(value) => setAnswers((prev) => ({ ...prev, [task.id]: value }))}
                />
              </Card>
            ))}
            <Form method="post" className="flex items-center gap-3" onSubmit={forget}>
              <input type="hidden" name="answers" value={JSON.stringify(answers)} />
              <Button
                type="submit"
                disabled={answered < tasks.length || navigation.state !== 'idle'}
              >
                Submit test
              </Button>
              <span className="text-sm text-slate-500">
                {answered} of {tasks.length} answered
              </span>
            </Form>
          </>
        )}
      </div>
      {instructionsHtml && (
        <aside>
          <Card className="sticky top-4 max-h-[85vh] overflow-y-auto">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Instructions
            </h2>
            <MarkdownBody html={instructionsHtml} />
          </Card>
        </aside>
      )}
    </div>
  );
}
