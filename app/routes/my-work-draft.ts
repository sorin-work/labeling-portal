import type { Prisma } from '@prisma/client';
import { redirect } from 'react-router';

import { parseDraft } from '~/domain/drafts';
import { requireUser } from '~/lib/auth.server';
import { jsonError, requireSameOrigin } from '~/lib/http';
import { saveRevisionDraft } from '~/models/queue.server';

import type { Route } from './+types/my-work-draft';

/**
 * POST: the revise page saves the changes in progress to sent-back work and
 * the time spent on them here.
 */
export async function action({ request, params }: Route.ActionArgs) {
  requireSameOrigin(request);
  const { user } = await requireUser(request);
  const form = await request.formData();
  const parsed = parseDraft(form.get('draft'));
  if (!parsed.ok) return jsonError(parsed.reason, parsed.reason === 'too_large' ? 413 : 400);
  const result = await saveRevisionDraft(params.assignmentId, user.id, {
    draft: (parsed.draft ?? undefined) as Prisma.InputJsonObject | undefined,
    activeSeconds: Number(form.get('activeSeconds') ?? 0),
  });
  if (!result.ok) return jsonError(result.error, result.error === 'not_found' ? 404 : 409);
  return Response.json({ ok: true, draftSeconds: result.draftSeconds });
}

export async function loader({ params }: Route.LoaderArgs) {
  return redirect(`/my-work/${params.assignmentId}`);
}
