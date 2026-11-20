import type { QueueOrder } from '@prisma/client';
import { z } from 'zod';

import { parseAgreementThreshold, parseMaxExtraAnnotators } from './adjudication';
import { DEFAULT_DISPUTE_WINDOW_DAYS } from './disputes';
import { readOptionalNumber } from './form-fields';
import { parseMoney } from './payouts';
import { parseGoldEvery, parseQueueOrder } from './queue-order';
import { readSamplePercent } from './review-sampling';
import { parseTaskSchema, type TaskSchema } from './task-schema';

const int = (min: number, max: number, label: string) =>
  z.coerce
    .number({ message: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must be at most ${max}`);

export const projectFormSchema = z.object({
  name: z.string().trim().min(3, 'Give the project a name of at least 3 characters').max(120),
  description: z.string().trim().max(500, 'Keep the description under 500 characters'),
  instructions: z.string().max(50_000, 'Instructions are too long'),
  overlap: int(1, 10, 'Annotators per task'),
  timeLimitMinutes: int(1, 480, 'Time limit'),
  reviewRequired: z.boolean(),
  reviewSamplePercent: int(0, 100, 'Share to review'),
  disputeWindowDays: int(0, 90, 'Dispute window'),
  goldFeedback: z.boolean(),
  qualificationRequired: z.boolean(),
  qualificationPassPercent: int(1, 100, 'Pass mark'),
  payMode: z.enum(['PER_TASK', 'HOURLY']),
});

export type ProjectInput = z.infer<typeof projectFormSchema> & {
  schema: TaskSchema;
  rateCents: number;
  queueOrder: QueueOrder;
  /** about one gold task in every N; null leaves gold where its position puts it */
  goldEvery: number | null;
  /** a share from 0.01 to 1; null leaves every task to complete as before */
  agreementThreshold: number | null;
  maxExtraAnnotators: number;
};

export type ProjectFormResult =
  { ok: true; value: ProjectInput } | { ok: false; errors: Record<string, string> };

/** Reads the project create/edit form. The schema arrives as JSON text. */
export function parseProjectForm(form: FormData): ProjectFormResult {
  const errors: Record<string, string> = {};
  const parsed = projectFormSchema.safeParse({
    name: form.get('name') ?? '',
    description: form.get('description') ?? '',
    instructions: form.get('instructions') ?? '',
    overlap: form.get('overlap') ?? 1,
    timeLimitMinutes: form.get('timeLimitMinutes') ?? 30,
    reviewRequired: form.get('reviewRequired') === 'on',
    reviewSamplePercent: readSamplePercent(form.get('reviewSamplePercent')),
    disputeWindowDays: readOptionalNumber(
      form.get('disputeWindowDays'),
      DEFAULT_DISPUTE_WINDOW_DAYS,
    ),
    goldFeedback: form.get('goldFeedback') === 'on',
    qualificationRequired: form.get('qualificationRequired') === 'on',
    qualificationPassPercent: form.get('qualificationPassPercent') ?? 80,
    payMode: form.get('payMode') ?? 'PER_TASK',
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '_form');
      errors[key] ??= issue.message;
    }
  }
  const schema = parseTaskSchema(String(form.get('schema') ?? ''));
  if (!schema.ok) errors.schema = schema.errors.join('; ');
  const rateCents = parseMoney(String(form.get('rate') ?? '0'));
  if (rateCents === null) errors.rate = 'Enter the rate as an amount like 0.25 or 18.00';
  const queueOrder = parseQueueOrder(form.get('queueOrder'));
  if (!queueOrder.ok) errors.queueOrder = queueOrder.error;
  const goldEvery = parseGoldEvery(form.get('goldEvery'));
  if (!goldEvery.ok) errors.goldEvery = goldEvery.error;
  const threshold = parseAgreementThreshold(form.get('agreementThreshold'));
  if (!threshold.ok) errors.agreementThreshold = threshold.error;
  const extras = parseMaxExtraAnnotators(form.get('maxExtraAnnotators'));
  if (!extras.ok) errors.maxExtraAnnotators = extras.error;

  if (
    !parsed.success ||
    !schema.ok ||
    rateCents === null ||
    !queueOrder.ok ||
    !goldEvery.ok ||
    !threshold.ok ||
    !extras.ok
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      ...parsed.data,
      schema: schema.schema,
      rateCents,
      queueOrder: queueOrder.value,
      goldEvery: goldEvery.value,
      agreementThreshold: threshold.value,
      maxExtraAnnotators: extras.value,
    },
  };
}
