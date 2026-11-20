import type { TaskSchema } from '~/domain/task-schema';

/** One project of each labeling kind, with a task to go with it. */
export const KINDS = {
  text_classification: {
    schema: {
      kind: 'text_classification',
      textField: 'text',
      labels: ['positive', 'negative', 'neutral'],
      multiple: false,
    },
    data: { text: 'The delivery was quick and the box was intact.' },
  },
  image_classification: {
    schema: {
      kind: 'image_classification',
      imageField: 'image',
      labels: ['person', 'car', 'empty street'],
      multiple: true,
    },
    data: { image: '/street.png' },
  },
  ner: {
    schema: {
      kind: 'ner',
      textField: 'text',
      entities: [{ name: 'PERSON' }, { name: 'PLACE', color: '#0ea5e9' }],
    },
    data: { text: 'Ada Lovelace was born in London in 1815.' },
  },
  pairwise: {
    schema: {
      kind: 'pairwise',
      promptField: 'prompt',
      responseAField: 'a',
      responseBField: 'b',
      dimensions: [
        { key: 'helpful', label: 'Helpfulness' },
        { key: 'correct', label: 'Correctness', description: 'Facts are right' },
      ],
      allowTie: true,
      minRationaleLength: 20,
    },
    data: { prompt: 'Name a prime number.', a: 'Seven.', b: 'Nine.' },
  },
  bbox: {
    schema: { kind: 'bbox', imageField: 'image', labels: ['car', 'person'], minBoxSize: 4 },
    data: { image: '/street.png' },
  },
} satisfies Record<string, { schema: TaskSchema; data: Record<string, unknown> }>;

export type Kind = keyof typeof KINDS;
export const KIND_NAMES = Object.keys(KINDS) as Kind[];
