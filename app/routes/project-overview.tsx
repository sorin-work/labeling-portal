import { Form } from 'react-router';

import { MarkdownBody } from '~/components/markdown';
import { Alert, Button, Card, EmptyState } from '~/components/ui';
import { renderMarkdown } from '~/domain/markdown';
import { requireUser } from '~/lib/auth.server';
import { can } from '~/lib/permissions';
import { requireProject } from '~/models/projects.server';
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
  const queue = new URL(request.url).searchParams.get('queue');
  return {
    canAnnotate,
    activeAssignmentId: active?.id ?? null,
    queueMessage:
      queue === 'empty'
        ? 'There are no more tasks for you in this project right now.'
        : queue === 'inactive'
          ? 'This project is not taking work at the moment.'
          : null,
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
  };
}

export default function ProjectOverview({ loaderData }: Route.ComponentProps) {
  const { project, instructionsHtml, canAnnotate, activeAssignmentId, queueMessage } = loaderData;
  return (
    <div className="space-y-6">
      {queueMessage && <Alert tone="info">{queueMessage}</Alert>}
      {canAnnotate && project.status === 'ACTIVE' && (
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
        </Card>
      </div>
    </div>
  );
}
