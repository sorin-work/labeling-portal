import type { ProjectStatus } from '@prisma/client';
import { data, Form } from 'react-router';

import { ProjectForm } from '~/components/project-form';
import { Alert, Button, Card } from '~/components/ui';
import { centsToDecimal } from '~/domain/payouts';
import { parseProjectForm } from '~/domain/project-form';
import { refusalMessage } from '~/domain/schema-diff';
import { requireUser } from '~/lib/auth.server';
import { projectTitle } from '~/lib/meta';
import { redirectWithFlash } from '~/lib/flash.server';
import { badRequest } from '~/lib/http';
import {
  duplicateProject,
  requireProject,
  schemaUsage,
  setProjectStatus,
  updateProject,
} from '~/models/projects.server';

import type { Route } from './+types/project-settings';

const STATUS_ACTIONS: Record<string, { to: ProjectStatus; from: ProjectStatus[] }> = {
  activate: { to: 'ACTIVE', from: ['DRAFT', 'PAUSED', 'ARCHIVED'] },
  pause: { to: 'PAUSED', from: ['ACTIVE'] },
  archive: { to: 'ARCHIVED', from: ['DRAFT', 'ACTIVE', 'PAUSED'] },
};

export function meta({ matches }: Route.MetaArgs) {
  return projectTitle(matches, 'Settings');
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  return {
    project: {
      id: project.id,
      status: project.status,
      name: project.name,
      description: project.description,
      instructions: project.instructions,
      schema: JSON.stringify(project.schema, null, 2),
      overlap: project.overlap,
      timeLimitMinutes: project.timeLimitMinutes,
      reviewRequired: project.reviewRequired,
      reviewSamplePercent: project.reviewSamplePercent,
      disputeWindowDays: project.disputeWindowDays,
      goldFeedback: project.goldFeedback,
      queueOrder: project.queueOrder,
      goldEvery: project.goldEvery,
      qualificationRequired: project.qualificationRequired,
      qualificationPassPercent: project.qualificationPassPercent,
      payMode: project.payMode,
      rate: centsToDecimal(project.rateCents),
    },
    // lets the form show what a schema edit would break before it is saved
    usage: await schemaUsage(project.id),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  const form = await request.formData();
  const intent = String(form.get('intent') ?? 'save');

  if (intent === 'duplicate') {
    const copy = await duplicateProject(project, current.user.id);
    return redirectWithFlash(
      request,
      `/projects/${copy.id}/settings`,
      'Created a copy as a draft.',
    );
  }

  if (intent in STATUS_ACTIONS) {
    const change = STATUS_ACTIONS[intent];
    const changed = await setProjectStatus(project, current.user.id, change);
    if (!changed.ok) {
      throw badRequest(`A ${project.status.toLowerCase()} project cannot be changed that way`);
    }
    return redirectWithFlash(
      request,
      `/projects/${project.id}/settings`,
      `Project is now ${change.to.toLowerCase()}.`,
    );
  }

  const parsed = parseProjectForm(form);
  if (!parsed.ok) {
    return data({ errors: parsed.errors, saved: false, warnings: [] }, { status: 400 });
  }
  // the save writes its entry in the audit trail itself, with what changed
  const result = await updateProject(project.id, parsed.value, current.user.id);
  if (!result.ok) {
    return data(
      { errors: { schema: refusalMessage(result.breaking) }, saved: false, warnings: [] },
      { status: 400 },
    );
  }
  const warnings = result.changes.filter((c) => c.impact === 'warning').map((c) => c.reason);
  return { errors: undefined, saved: true, warnings };
}

export default function ProjectSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { project, usage } = loaderData;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {actionData?.saved && <Alert tone="success">Settings saved.</Alert>}
        {actionData?.warnings.map((warning) => (
          <Alert key={warning} tone="info">
            Keep in mind: {warning}.
          </Alert>
        ))}
        <ProjectForm
          key={project.schema}
          defaults={project}
          usage={usage}
          errors={actionData?.errors}
          submitLabel="Save changes"
          allowTemplates={false}
        />
      </div>
      <Card className="h-fit space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Status</h2>
        <p className="text-sm text-slate-600">
          {project.status === 'DRAFT' && 'Draft projects are only visible to managers.'}
          {project.status === 'ACTIVE' && 'Annotators can claim tasks from this project.'}
          {project.status === 'PAUSED' && 'Paused: nobody can claim new tasks.'}
          {project.status === 'ARCHIVED' && 'Archived projects are read-only.'}
        </p>
        <Form method="post" className="flex flex-wrap gap-2">
          {project.status !== 'ACTIVE' && (
            <Button name="intent" value="activate">
              {project.status === 'DRAFT' ? 'Launch project' : 'Reactivate'}
            </Button>
          )}
          {project.status === 'ACTIVE' && (
            <Button name="intent" value="pause" variant="secondary">
              Pause
            </Button>
          )}
          {project.status !== 'ARCHIVED' && (
            <Button name="intent" value="archive" variant="danger">
              Archive
            </Button>
          )}
        </Form>
        <Form method="post" className="border-t border-slate-100 pt-3">
          <p className="mb-2 text-sm text-slate-600">
            Start a new project with the same schema, instructions, rates and members.
          </p>
          <Button name="intent" value="duplicate" variant="secondary">
            Duplicate project
          </Button>
        </Form>
      </Card>
    </div>
  );
}
