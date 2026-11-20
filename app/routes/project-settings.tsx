import type { ProjectStatus } from '@prisma/client';
import { data, Form } from 'react-router';

import { ProjectForm } from '~/components/project-form';
import { Alert, Button, Card } from '~/components/ui';
import { centsToDecimal } from '~/domain/payouts';
import { rulesFor } from '~/domain/prelabel';
import { parseProjectForm } from '~/domain/project-form';
import { refusalMessage } from '~/domain/schema-diff';
import { requireUser } from '~/lib/auth.server';
import { projectTitle } from '~/lib/meta';
import { redirectWithFlash } from '~/lib/flash.server';
import { badRequest } from '~/lib/http';
import {
  duplicateProject,
  projectSchema,
  requireProject,
  schemaUsage,
  setProjectPrelabel,
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
      agreementThreshold:
        project.agreementThreshold === null ? null : Math.round(project.agreementThreshold * 100),
      maxExtraAnnotators: project.maxExtraAnnotators,
      qualificationRequired: project.qualificationRequired,
      qualificationPassPercent: project.qualificationPassPercent,
      payMode: project.payMode,
      rate: centsToDecimal(project.rateCents),
    },
    // lets the form show what a schema edit would break before it is saved
    usage: await schemaUsage(project.id),
    prelabel: {
      text: project.prelabel === null ? '' : JSON.stringify(project.prelabel, null, 2),
      rules: rulesFor(projectSchema(project).kind).map((r) => ({
        name: r.name,
        title: r.title,
        example: JSON.stringify(PRELABEL_EXAMPLES[r.name as keyof typeof PRELABEL_EXAMPLES]),
      })),
    },
  };
}

/** What the settings page offers as a start for each rule. */
const PRELABEL_EXAMPLES = {
  keywords: { rule: 'keywords', labels: { positive: ['great', 'love it'] } },
  phrases: { rule: 'phrases', entities: { PERSON: ['Ada Lovelace'] } },
};

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

  if (intent === 'prelabel') {
    const result = await setProjectPrelabel(
      project,
      String(form.get('prelabel') ?? ''),
      current.user.id,
    );
    if (!result.ok) {
      return data(
        {
          errors: undefined,
          saved: false,
          warnings: [],
          prelabelErrors: result.errors,
        },
        { status: 400 },
      );
    }
    return redirectWithFlash(
      request,
      `/projects/${project.id}/settings`,
      'Suggestion rule saved. It applies to batches imported from now on.',
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
    return data(
      { errors: parsed.errors, saved: false, warnings: [], prelabelErrors: undefined },
      { status: 400 },
    );
  }
  // the save writes its entry in the audit trail itself, with what changed
  const result = await updateProject(project.id, parsed.value, current.user.id);
  if (!result.ok) {
    return data(
      {
        errors: { schema: refusalMessage(result.breaking) },
        saved: false,
        warnings: [],
        prelabelErrors: undefined,
      },
      { status: 400 },
    );
  }
  const warnings = result.changes.filter((c) => c.impact === 'warning').map((c) => c.reason);
  return { errors: undefined, saved: true, warnings, prelabelErrors: undefined };
}

export default function ProjectSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { project, usage, prelabel } = loaderData;
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
        <Form method="post" className="space-y-2 border-t border-slate-100 pt-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Suggested answers
          </h2>
          {prelabel.rules.length === 0 ? (
            <p className="text-sm text-slate-600">
              No rule suggests answers for this kind of project. A <code>_prediction</code> column
              in an import file still can.
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                A rule that suggests an answer for each task of a batch imported from now on.
                Annotators see the suggestion as a suggestion and take it or not. Leave the box
                empty for no rule. Rules for this kind:
              </p>
              <ul className="text-xs text-slate-600">
                {prelabel.rules.map((rule) => (
                  <li key={rule.name}>
                    <span className="font-medium">{rule.title}</span>, for example{' '}
                    <code className="break-all">{rule.example}</code>
                  </li>
                ))}
              </ul>
              <label htmlFor="prelabel" className="sr-only">
                Suggestion rule (JSON)
              </label>
              <textarea
                id="prelabel"
                name="prelabel"
                rows={6}
                defaultValue={prelabel.text}
                spellCheck={false}
                className="block w-full rounded-md px-3 py-2 font-mono text-xs ring-1 ring-slate-300"
              />
              {actionData?.prelabelErrors && (
                <p className="text-xs text-rose-700" role="alert">
                  {actionData.prelabelErrors.join('; ')}
                </p>
              )}
              <Button name="intent" value="prelabel" variant="secondary">
                Save the rule
              </Button>
            </>
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
