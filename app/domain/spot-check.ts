/**
 * Spot checks: a reviewer looks at accepted work that no reviewer has seen
 * (work the review sample left out, or work in a project without review)
 * and records a QA score, a verdict and feedback. The work is payable and
 * may have completed its task already, so a spot check changes no status,
 * no pay and no answer; it is a `Review` row with `spotCheck` set and
 * nothing else. Spot checks are picked, not drawn, so they lean towards bad
 * work: they stay out of the approval rate, the reviewed share and the QA
 * average, and cannot be disputed.
 */

export type SpotCheckVerdict = 'APPROVE' | 'SEND_BACK';

export const SPOT_CHECK_VERDICTS: Record<SpotCheckVerdict, string> = {
  APPROVE: 'Fine',
  SEND_BACK: 'Would have sent it back',
};

export type SpotCheckRefusal = 'not_unseen' | 'gold' | 'own_work';

/** Why a submission cannot be spot checked by this person, or null when it can. */
export function spotCheckRefusal(input: {
  status: string;
  reviewStatus: string | null;
  isGold: boolean;
  isQualification: boolean;
  /** how many reviews the submission has, spot checks among them */
  reviews: number;
  ownWork: boolean;
}): SpotCheckRefusal | null {
  if (input.ownWork) return 'own_work';
  // gold is scored against its known answer, and is NOT_REQUIRED too
  if (input.isGold || input.isQualification) return 'gold';
  if (input.status !== 'SUBMITTED' || input.reviewStatus !== 'NOT_REQUIRED') return 'not_unseen';
  if (input.reviews > 0) return 'not_unseen';
  return null;
}

export type SpotCheckForm = { verdict: SpotCheckVerdict; qaScore: number; feedback: string };

/**
 * Reads the spot-check form. The score is required, since recording it is
 * the point; "would have sent it back" needs feedback, as a send-back does.
 */
export function parseSpotCheckForm(
  form: FormData,
): { ok: true; value: SpotCheckForm } | { ok: false; error: string } {
  const intent = String(form.get('intent') ?? '');
  const verdict: SpotCheckVerdict | null =
    intent === 'spot_fine' ? 'APPROVE' : intent === 'spot_send_back' ? 'SEND_BACK' : null;
  if (!verdict) return { ok: false, error: 'Choose fine or would have sent it back.' };
  const qaScore = Number(String(form.get('qaScore') ?? '').trim() || Number.NaN);
  if (!Number.isInteger(qaScore) || qaScore < 1 || qaScore > 5) {
    return { ok: false, error: 'Give the work a quality score from 1 to 5.' };
  }
  const feedback = String(form.get('feedback') ?? '').trim();
  if (feedback.length > 2000) return { ok: false, error: 'Keep feedback under 2000 characters.' };
  if (verdict === 'SEND_BACK' && !feedback) {
    return { ok: false, error: 'Tell the annotator what you would have had them change.' };
  }
  return { ok: true, value: { verdict, qaScore, feedback } };
}
