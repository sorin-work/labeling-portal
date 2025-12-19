import type { ProjectStatus } from '@prisma/client';
import { data, Form, redirect } from 'react-router';

import { ProjectForm } from '~/components/project-form';
import { Alert, Button, Card } from '~/components/ui';
import { parseProjectForm } from '~/domain/project-form';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { badRequest } from '~/lib/http';
import { requireProject, updateProject } from '~/models/projects.server';

import type { Route } from './+types/project-settings';

const STATUS_ACTIONS: Record<string, { to: ProjectStatus; from: ProjectStatus[] }> = {
  activate: { to: 'ACTIVE', from: ['DRAFT', 'PAUSED', 'ARCHIVED'] },
  pause: { to: 'PAUSED', from: ['ACTIVE'] },
  archive: { to: 'ARCHIVED', from: ['DRAFT', 'ACTIVE', 'PAUSED'] },
};

export function meta() {
  return [{ title: 'Project settings · Labeling Portal' }];
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
    },
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  const form = await request.formData();
  const intent = String(form.get('intent') ?? 'save');

  if (intent in STATUS_ACTIONS) {
    const change = STATUS_ACTIONS[intent];
    if (!change.from.includes(project.status)) {
      throw badRequest(`A ${project.status.toLowerCase()} project cannot be changed that way`);
    }
    await prisma.project.update({ where: { id: project.id }, data: { status: change.to } });
    return redirect(`/projects/${project.id}/settings`);
  }

  const parsed = parseProjectForm(form);
  if (!parsed.ok) return data({ errors: parsed.errors, saved: false }, { status: 400 });
  await updateProject(project.id, parsed.value);
  return { errors: undefined, saved: true };
}

export default function ProjectSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { project } = loaderData;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {actionData?.saved && <Alert tone="success">Settings saved.</Alert>}
        <ProjectForm
          key={project.schema}
          defaults={project}
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
      </Card>
    </div>
  );
}
