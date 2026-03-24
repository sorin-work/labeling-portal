import { z } from 'zod';

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
  qualificationRequired: z.boolean(),
  qualificationPassPercent: int(1, 100, 'Pass mark'),
});

export type ProjectInput = z.infer<typeof projectFormSchema> & { schema: TaskSchema };

export type ProjectFormResult =
  | { ok: true; value: ProjectInput }
  | { ok: false; errors: Record<string, string> };

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
    qualificationRequired: form.get('qualificationRequired') === 'on',
    qualificationPassPercent: form.get('qualificationPassPercent') ?? 80,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '_form');
      errors[key] ??= issue.message;
    }
  }
  const schema = parseTaskSchema(String(form.get('schema') ?? ''));
  if (!schema.ok) errors.schema = schema.errors.join('; ');

  if (!parsed.success || !schema.ok) return { ok: false, errors };
  return { ok: true, value: { ...parsed.data, schema: schema.schema } };
}
