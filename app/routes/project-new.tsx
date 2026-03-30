import { data, redirect } from 'react-router';

import { EMPTY_PROJECT, ProjectForm } from '~/components/project-form';
import { PageHeader } from '~/components/ui';
import { parseProjectForm } from '~/domain/project-form';
import { requireRole } from '~/lib/auth.server';
import { createProject } from '~/models/projects.server';

import type { Route } from './+types/project-new';

const MANAGERS = ['ADMIN', 'PROJECT_MANAGER'] as const;

export function meta() {
  return [{ title: 'New project · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, [...MANAGERS]);
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const { membership } = await requireRole(request, [...MANAGERS]);
  const form = await request.formData();
  const parsed = parseProjectForm(form);
  if (!parsed.ok) {
    return data(
      {
        errors: parsed.errors,
        values: Object.fromEntries(form) as Record<string, string>,
      },
      { status: 400 },
    );
  }
  const project = await createProject(membership.orgId, parsed.value);
  return redirect(`/projects/${project.id}`);
}

export default function NewProject({ actionData }: Route.ComponentProps) {
  const values = actionData?.values;
  const defaults = values
    ? {
        ...EMPTY_PROJECT,
        ...values,
        overlap: Number(values.overlap) || 1,
        timeLimitMinutes: Number(values.timeLimitMinutes) || 30,
        reviewRequired: values.reviewRequired === 'on',
        qualificationRequired: values.qualificationRequired === 'on',
        qualificationPassPercent: Number(values.qualificationPassPercent) || 80,
        payMode: values.payMode === 'HOURLY' ? ('HOURLY' as const) : ('PER_TASK' as const),
      }
    : EMPTY_PROJECT;

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="New project"
        subtitle="Pick a labeling kind, adjust the schema and write instructions for annotators."
      />
      <ProjectForm
        defaults={defaults}
        errors={actionData?.errors}
        submitLabel="Create project"
        allowTemplates
      />
    </div>
  );
}
