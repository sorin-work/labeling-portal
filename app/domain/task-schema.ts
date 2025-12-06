import { z } from 'zod';

/**
 * A project's task schema says which labeling interface annotators get and
 * which fields of an imported row it reads. It is stored as JSON on the
 * project and edited as JSON by project managers.
 */

const fieldName = z
  .string()
  .trim()
  .min(1, 'Field names cannot be empty')
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'Field names may use letters, digits, _ . and -');

const labelName = z.string().trim().min(1, 'Labels cannot be empty').max(64);

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Colours must look like #a1b2c3')
  .optional();

function uniqueBy<T>(key: (item: T) => string, message: string) {
  return (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    for (const item of items) {
      const k = key(item).toLowerCase();
      if (seen.has(k)) {
        ctx.addIssue({ code: 'custom', message: `${message}: ${key(item)}` });
        return;
      }
      seen.add(k);
    }
  };
}

export const textClassificationSchema = z.object({
  kind: z.literal('text_classification'),
  textField: fieldName,
  labels: z
    .array(labelName)
    .min(2, 'Add at least two labels')
    .max(30)
    .superRefine(uniqueBy((l) => l, 'Duplicate label')),
  multiple: z.boolean().default(false),
});

export const nerSchema = z.object({
  kind: z.literal('ner'),
  textField: fieldName,
  entities: z
    .array(z.object({ name: labelName, color: hexColor }))
    .min(1, 'Add at least one entity type')
    .max(20)
    .superRefine(uniqueBy((e) => e.name, 'Duplicate entity type')),
});

export const pairwiseSchema = z.object({
  kind: z.literal('pairwise'),
  promptField: fieldName,
  responseAField: fieldName,
  responseBField: fieldName,
  dimensions: z
    .array(
      z.object({
        key: fieldName,
        label: z.string().trim().min(1).max(80),
        description: z.string().trim().max(500).optional(),
      }),
    )
    .min(1, 'Add at least one rubric dimension')
    .max(10)
    .superRefine(uniqueBy((d) => d.key, 'Duplicate dimension key')),
  allowTie: z.boolean().default(true),
  minRationaleLength: z.number().int().min(0).max(2000).default(20),
});

export const bboxSchema = z.object({
  kind: z.literal('bbox'),
  imageField: fieldName,
  labels: z
    .array(labelName)
    .min(1, 'Add at least one box label')
    .max(30)
    .superRefine(uniqueBy((l) => l, 'Duplicate label')),
  minBoxSize: z.number().int().min(1).max(200).default(4),
});

export const taskSchema = z.discriminatedUnion('kind', [
  textClassificationSchema,
  nerSchema,
  pairwiseSchema,
  bboxSchema,
]);

export type TaskSchema = z.infer<typeof taskSchema>;
export type TextClassificationSchema = z.infer<typeof textClassificationSchema>;
export type NerSchema = z.infer<typeof nerSchema>;
export type PairwiseSchema = z.infer<typeof pairwiseSchema>;
export type BboxSchema = z.infer<typeof bboxSchema>;
export type SchemaKind = TaskSchema['kind'];

export const KIND_TO_ENUM = {
  text_classification: 'TEXT_CLASSIFICATION',
  ner: 'NER',
  pairwise: 'PAIRWISE',
  bbox: 'BBOX',
} as const satisfies Record<SchemaKind, string>;

export const KIND_LABELS: Record<SchemaKind, string> = {
  text_classification: 'Text classification',
  ner: 'Named entities',
  pairwise: 'Pairwise comparison',
  bbox: 'Bounding boxes',
};

export type ParseResult = { ok: true; schema: TaskSchema } | { ok: false; errors: string[] };

/** Parses a schema from JSON text or an already-decoded value. */
export function parseTaskSchema(input: unknown): ParseResult {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, errors: ['The schema is not valid JSON'] };
    }
  }
  const result = taskSchema.safeParse(value);
  if (result.success) return { ok: true, schema: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    ),
  };
}

/** The row fields an imported task must have for this schema. */
export function requiredFields(schema: TaskSchema): string[] {
  switch (schema.kind) {
    case 'text_classification':
    case 'ner':
      return [schema.textField];
    case 'pairwise':
      return [schema.promptField, schema.responseAField, schema.responseBField];
    case 'bbox':
      return [schema.imageField];
  }
}

export const SCHEMA_TEMPLATES: Record<SchemaKind, TaskSchema> = {
  text_classification: {
    kind: 'text_classification',
    textField: 'text',
    labels: ['positive', 'neutral', 'negative'],
    multiple: false,
  },
  ner: {
    kind: 'ner',
    textField: 'text',
    entities: [
      { name: 'PERSON', color: '#f59e0b' },
      { name: 'ORG', color: '#6366f1' },
      { name: 'LOCATION', color: '#10b981' },
    ],
  },
  pairwise: {
    kind: 'pairwise',
    promptField: 'prompt',
    responseAField: 'response_a',
    responseBField: 'response_b',
    dimensions: [
      { key: 'helpfulness', label: 'Helpfulness', description: 'Does it answer the request?' },
      { key: 'accuracy', label: 'Accuracy', description: 'Are the facts and reasoning right?' },
      { key: 'safety', label: 'Safety', description: 'Does it avoid harmful content?' },
    ],
    allowTie: true,
    minRationaleLength: 20,
  },
  bbox: {
    kind: 'bbox',
    imageField: 'image_url',
    labels: ['car', 'person', 'bicycle'],
    minBoxSize: 4,
  },
};
