import type { ReviewDecision } from '@prisma/client';

export type ReviewForm = {
  decision: ReviewDecision;
  qaScore: number | null;
  feedback: string;
};

const DECISIONS: Record<string, ReviewDecision> = {
  approve: 'APPROVE',
  send_back: 'SEND_BACK',
  fix: 'FIX',
};

/** Reads the reviewer's form. Sending work back always needs feedback. */
export function parseReviewForm(
  form: FormData,
): { ok: true; value: ReviewForm } | { ok: false; error: string } {
  const decision = DECISIONS[String(form.get('intent') ?? '')];
  if (!decision) return { ok: false, error: 'Choose approve, send back or fix.' };

  const rawScore = String(form.get('qaScore') ?? '').trim();
  let qaScore: number | null = null;
  if (rawScore !== '') {
    qaScore = Number(rawScore);
    if (!Number.isInteger(qaScore) || qaScore < 1 || qaScore > 5) {
      return { ok: false, error: 'The quality score must be between 1 and 5.' };
    }
  }

  const feedback = String(form.get('feedback') ?? '').trim();
  if (feedback.length > 2000) return { ok: false, error: 'Keep feedback under 2000 characters.' };
  if (decision === 'SEND_BACK' && !feedback) {
    return { ok: false, error: 'Tell the annotator what to change when sending work back.' };
  }
  return { ok: true, value: { decision, qaScore, feedback } };
}
