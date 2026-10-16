import { Form, Link } from 'react-router';

import { MarkdownBody } from '~/components/markdown';
import { Alert, Button, Card, EmptyState } from '~/components/ui';
import { renderMarkdown } from '~/domain/markdown';
import type { TaskSchema } from '~/domain/task-schema';

function schemaChoices(schema: TaskSchema): { title: string; items: string[] } {
  switch (schema.kind) {
    case 'text_classification':
      return {
        title: schema.multiple ? 'Labels (pick any)' : 'Labels (pick one)',
        items: schema.labels,
      };
    case 'ner':
      return { title: 'Entity types', items: schema.entities.map((e) => e.name) };
    case 'pairwise':
      return { title: 'Rubric', items: schema.dimensions.map((d) => d.label) };
    case 'bbox':
      return { title: 'Box labels', items: schema.labels };
  }
}
import { requireUser } from '~/lib/auth.server';
import { can } from '~/lib/permissions';
import { queueMessage } from '~/lib/queue-messages';
import { projectSchema, requireProject } from '~/models/projects.server';
import { projectProgress } from '~/models/progress.server';
import { qualificationStatus } from '~/models/qualification.server';
import { findActiveAssignment } from '~/models/queue.server';

import type { Route } from './+types/project-overview';

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.project.name ?? 'Project'} · Labeling Portal` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId);
  const canAnnotate = can(current.membership.role, 'annotate');
  const active = canAnnotate ? await findActiveAssignment(project.id, current.user.id) : null;
  const qualification = canAnnotate ? await qualificationStatus(project, current.user.id) : null;
  const seesProgress =
    can(current.membership.role, 'manageProjects') || can(current.membership.role, 'review');
  const progress = seesProgress ? await projectProgress(project.id) : null;
  const queue = new URL(request.url).searchParams.get('queue');
  return {
    canAnnotate,
    activeAssignmentId: active?.id ?? null,
    queueMessage: queueMessage(queue),
    needsQualification: qualification ? !qualification.qualified : false,
    progress,
    project: {
      id: project.id,
      status: project.status,
      name: project.name,
      description: project.description,
      overlap: project.overlap,
      timeLimitMinutes: project.timeLimitMinutes,
      reviewRequired: project.reviewRequired,
    },
    instructionsHtml: renderMarkdown(project.instructions),
    choices: schemaChoices(projectSchema(project)),
  };
}

export default function ProjectOverview({ loaderData }: Route.ComponentProps) {
  const {
    project,
    instructionsHtml,
    canAnnotate,
    activeAssignmentId,
    queueMessage,
    needsQualification,
    progress,
    choices,
  } = loaderData;
  const pct =
    progress && progress.tasks ? Math.round((progress.complete / progress.tasks) * 100) : 0;
  return (
    <div className="space-y-6">
      {queueMessage && <Alert tone="info">{queueMessage}</Alert>}
      {progress && (
        <Card>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Progress
            </h2>
            <span className="text-sm text-slate-600">
              {progress.complete} of {progress.tasks} tasks complete ({pct}%)
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-slate-100">
            <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-slate-500">Waiting for review</dt>
              <dd className="font-medium">{progress.pendingReview}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Being worked on</dt>
              <dd className="font-medium">{progress.activeClaims}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Skipped</dt>
              <dd className="font-medium">{progress.skipped}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Gold tasks</dt>
              <dd className="font-medium">{progress.gold}</dd>
            </div>
          </dl>
        </Card>
      )}
      {canAnnotate && project.status === 'ACTIVE' && needsQualification && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium">Qualification required</div>
            <div className="text-sm text-slate-500">
              Read the instructions, then pass a short test to start working on this project.
            </div>
          </div>
          <Link to={`/projects/${project.id}/qualification`}>
            <Button>Take the test</Button>
          </Link>
        </Card>
      )}
      {canAnnotate && project.status === 'ACTIVE' && !needsQualification && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium">
              {activeAssignmentId ? 'You have a task in progress' : 'Ready to label?'}
            </div>
            <div className="text-sm text-slate-500">
              Read the instructions first. Tasks are reserved for you for {project.timeLimitMinutes}{' '}
              minutes.
            </div>
          </div>
          <Form method="post" action={`/projects/${project.id}/work`}>
            <Button>{activeAssignmentId ? 'Continue' : 'Start labeling'}</Button>
          </Form>
        </Card>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Instructions
          </h2>
          {instructionsHtml ? (
            <MarkdownBody html={instructionsHtml} />
          ) : (
            <EmptyState title="No instructions yet">
              Project managers can add guidelines from the settings tab.
            </EmptyState>
          )}
        </Card>
        <Card>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Setup
          </h2>
          {project.description && (
            <p className="mb-3 text-sm text-slate-600">{project.description}</p>
          )}
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Annotators per task</dt>
              <dd className="font-medium">{project.overlap}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Time limit</dt>
              <dd className="font-medium">{project.timeLimitMinutes} min</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Review</dt>
              <dd className="font-medium">
                {project.reviewRequired ? 'Every submission' : 'Optional'}
              </dd>
            </div>
          </dl>
          <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {choices.title}
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {choices.items.map((item) => (
              <li key={item} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                {item}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
