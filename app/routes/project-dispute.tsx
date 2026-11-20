import { data, Form, Link, useNavigation } from 'react-router';

import { LabelingInterface } from '~/components/labeling';
import { Alert, Badge, Button, Card } from '~/components/ui';
import type { Answer } from '~/domain/answers';
import {
  MAX_DISPUTE_TEXT,
  parseResolution,
  RESOLVER_REFUSALS,
  resolverRefusal,
} from '~/domain/disputes';
import { requireUser } from '~/lib/auth.server';
import { redirectWithFlash } from '~/lib/flash.server';
import { DECISION_WORDS, DISPUTE_BADGES, formatDateTime } from '~/lib/format';
import { forbidden, notFound } from '~/lib/http';
import { projectTitle } from '~/lib/meta';
import { findDispute, resolveDispute } from '~/models/disputes.server';
import { projectSchema, requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-dispute';

export function meta({ matches }: Route.MetaArgs) {
  return projectTitle(matches, 'Dispute');
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'review');
  const dispute = await findDispute(project.id, params.disputeId);
  if (!dispute) throw notFound('Dispute not found');
  const { review, assignment } = dispute;
  const barred = resolverRefusal({
    resolverId: current.user.id,
    reviewerId: review.reviewerId,
    annotatorId: assignment.userId,
  });

  return {
    projectId: project.id,
    schema: projectSchema(project),
    barred: barred && RESOLVER_REFUSALS[barred],
    dispute: {
      id: dispute.id,
      status: dispute.status,
      annotator: dispute.openedBy.name,
      reason: dispute.reason,
      openedAt: dispute.createdAt,
      resolution: dispute.resolution,
      resolver: dispute.resolvedBy?.name ?? null,
      resolvedAt: dispute.resolvedAt,
      // the answer as it stood when the dispute was opened
      answer: dispute.answer as Answer,
    },
    review: {
      reviewer: review.reviewer.name,
      decision: review.decision,
      qaScore: review.qaScore,
      feedback: review.feedback,
      decidedAt: review.createdAt,
      corrected: (review.correctedAnswer ?? null) as Answer | null,
    },
    task: {
      id: assignment.task.id,
      externalId: assignment.task.externalId,
      data: assignment.task.data as Record<string, unknown>,
    },
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'review');
  const dispute = await findDispute(project.id, params.disputeId);
  if (!dispute) throw notFound('Dispute not found');

  const parsed = parseResolution(await request.formData());
  if (!parsed.ok) return data({ error: parsed.error }, { status: 400 });

  // who may settle it, and that it is still open, is decided in resolveDispute
  const result = await resolveDispute(dispute.id, current.user.id, parsed);
  if (!result.ok) {
    if (result.error === 'not_found') throw notFound('Dispute not found');
    if (result.error === 'already_resolved') {
      return data({ error: 'Someone already settled this dispute.' }, { status: 409 });
    }
    throw forbidden(RESOLVER_REFUSALS[result.error]);
  }
  return redirectWithFlash(
    request,
    `/projects/${project.id}/disputes`,
    parsed.outcome === 'OVERTURNED'
      ? 'Decision overturned. The work now counts as approved.'
      : 'Decision upheld.',
  );
}

export default function ProjectDispute({ loaderData, actionData }: Route.ComponentProps) {
  const { projectId, schema, dispute, review, task, barred } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';
  const badge = DISPUTE_BADGES[dispute.status];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link to={`/projects/${projectId}/disputes`} className="text-indigo-700 hover:underline">
          ← Disputes
        </Link>
        <Link
          to={`/projects/${projectId}/tasks/${task.id}`}
          className="text-slate-500 hover:text-slate-800"
        >
          All submissions for this task
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">
          {dispute.annotator} disputes work {DECISION_WORDS[review.decision]} by {review.reviewer}
        </h2>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {task.externalId && (
          <span className="font-mono text-xs text-slate-500">{task.externalId}</span>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            The annotator&apos;s reason
          </h3>
          <p className="whitespace-pre-wrap text-sm">{dispute.reason}</p>
          <p className="mt-2 text-xs text-slate-500">Opened {formatDateTime(dispute.openedAt)}</p>
        </Card>
        <Card>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            The reviewer&apos;s decision
          </h3>
          <p className="text-sm">
            {review.reviewer} {DECISION_WORDS[review.decision]} the work
            {review.qaScore !== null && ` with a quality score of ${review.qaScore}/5`}.
          </p>
          {review.feedback && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{review.feedback}</p>
          )}
          <p className="mt-2 text-xs text-slate-500">Decided {formatDateTime(review.decidedAt)}</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            The annotator&apos;s answer
          </h3>
          <LabelingInterface
            schema={schema}
            data={task.data}
            value={dispute.answer}
            onChange={() => {}}
            readOnly
            viewKey={`${dispute.id}:answer`}
          />
        </Card>
        <Card>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            The reviewer&apos;s correction
          </h3>
          {review.corrected ? (
            <LabelingInterface
              schema={schema}
              data={task.data}
              value={review.corrected}
              onChange={() => {}}
              readOnly
              viewKey={`${dispute.id}:corrected`}
            />
          ) : (
            <p className="text-sm text-slate-500">
              The reviewer sent the work back with the feedback above and did not change it.
            </p>
          )}
        </Card>
      </div>

      {actionData?.error && <Alert>{actionData.error}</Alert>}
      {dispute.status !== 'OPEN' ? (
        <Card>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Outcome
          </h3>
          <p className="text-sm">
            {badge.label}
            {dispute.resolver && ` by ${dispute.resolver}`}
            {dispute.resolvedAt && ` on ${formatDateTime(dispute.resolvedAt)}`}.
          </p>
          {dispute.resolution && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{dispute.resolution}</p>
          )}
        </Card>
      ) : barred ? (
        <Alert tone="info">{barred}</Alert>
      ) : (
        <Form
          method="post"
          className="space-y-3 rounded-lg bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200"
        >
          <p className="text-slate-600">
            Upholding leaves the decision as it is. Overturning takes it back: the annotator&apos;s
            answer counts as approved, and the review no longer counts in their numbers or the
            reviewer&apos;s.
          </p>
          <label className="block font-medium">
            Note for the annotator and the reviewer
            <textarea
              name="resolution"
              rows={3}
              required
              maxLength={MAX_DISPUTE_TEXT}
              className="mt-1 block w-full rounded-md px-3 py-2 font-normal ring-1 ring-slate-300"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button name="intent" value="uphold" variant="secondary" disabled={busy}>
              Uphold the decision
            </Button>
            <Button name="intent" value="overturn" disabled={busy}>
              Overturn the decision
            </Button>
          </div>
        </Form>
      )}
    </div>
  );
}
