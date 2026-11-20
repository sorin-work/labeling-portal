import { describe, expect, it } from 'vitest';

import {
  breakingChanges,
  describeSchemaChange,
  diffSchema,
  NO_USAGE,
  refusalMessage,
  REDESIGN_HINT,
  type AnswerCounts,
  type SchemaUsage,
} from '~/domain/schema-diff';
import {
  SCHEMA_TEMPLATES,
  type BboxSchema,
  type NerSchema,
  type PairwiseSchema,
  type TextClassificationSchema,
} from '~/domain/task-schema';

const classification = SCHEMA_TEMPLATES.text_classification;
const ner = SCHEMA_TEMPLATES.ner;
const pairwise = SCHEMA_TEMPLATES.pairwise;
const bbox = SCHEMA_TEMPLATES.bbox;

/** A plain number stands for that many submissions, the most common place. */
type Count = number | AnswerCounts;

function counts(value: Count = 0): AnswerCounts {
  if (typeof value !== 'number') return value;
  return value > 0 ? { submission: value } : {};
}

function usage(
  parts: {
    tasks?: number;
    answers?: Count;
    names?: Record<string, Count>;
    multiLabel?: Count;
    ties?: Count;
    scored?: Count;
    dimensions?: Record<string, Count>;
  } = {},
): SchemaUsage {
  const byName = (record: Record<string, Count> = {}) =>
    new Map(Object.entries(record).map(([name, value]) => [name, counts(value)]));
  return {
    tasks: parts.tasks ?? 0,
    answers: counts(parts.answers),
    names: byName(parts.names),
    multiLabel: counts(parts.multiLabel),
    ties: counts(parts.ties),
    scored: counts(parts.scored),
    dimensions: byName(parts.dimensions),
  };
}

/** `[impact, summary]` of every change, which is what most tests care about. */
function impacts(changes: ReturnType<typeof diffSchema>) {
  return changes.map((c) => [c.impact, c.summary]);
}

describe('diffSchema', () => {
  it('finds nothing between equal schemas', () => {
    for (const template of Object.values(SCHEMA_TEMPLATES)) {
      expect(diffSchema(template, structuredClone(template), usage({ tasks: 9 }))).toEqual([]);
    }
  });

  it('reports every property that can differ', () => {
    const edits: Array<[object, object]> = [
      [classification, { ...classification, textField: 'body' }],
      [classification, { ...classification, labels: ['negative', 'neutral', 'positive'] }],
      [classification, { ...classification, multiple: true }],
      [ner, { ...ner, textField: 'body' }],
      [ner, { ...ner, entities: [...ner.entities].reverse() }],
      [ner, { ...ner, entities: ner.entities.map((e) => ({ ...e, color: '#000000' })) }],
      [pairwise, { ...pairwise, promptField: 'question' }],
      [pairwise, { ...pairwise, responseAField: 'left' }],
      [pairwise, { ...pairwise, responseBField: 'right' }],
      [pairwise, { ...pairwise, dimensions: [...pairwise.dimensions].reverse() }],
      [
        pairwise,
        { ...pairwise, dimensions: pairwise.dimensions.map((d) => ({ ...d, label: 'Other' })) },
      ],
      [
        pairwise,
        {
          ...pairwise,
          dimensions: pairwise.dimensions.map((d) => ({ ...d, description: undefined })),
        },
      ],
      [pairwise, { ...pairwise, allowTie: false }],
      [pairwise, { ...pairwise, minRationaleLength: 21 }],
      [bbox, { ...bbox, imageField: 'url' }],
      [bbox, { ...bbox, labels: ['person', 'car', 'bicycle'] }],
      [bbox, { ...bbox, minBoxSize: 5 }],
    ];
    for (const [before, after] of edits) {
      expect(diffSchema(before as never, after as never), JSON.stringify(after)).not.toEqual([]);
    }
  });

  describe('kind', () => {
    it('may change while the project is empty', () => {
      expect(diffSchema(classification, bbox)).toEqual([
        {
          field: 'kind',
          impact: 'safe',
          summary: 'changed the kind from text classification to bounding boxes',
          reason: '',
          affected: 0,
        },
      ]);
    });

    it('is breaking as soon as the project has a task', () => {
      const [change, ...rest] = diffSchema(classification, ner, usage({ tasks: 1 }));
      expect(rest).toEqual([]);
      expect(change).toMatchObject({
        field: 'kind',
        impact: 'breaking',
        reason: 'the kind cannot change once the project has 1 task',
        affected: 1,
      });
    });

    it('is breaking when answers are stored, even if no task is counted', () => {
      const stored = { submission: 3, consensus: 1 };
      const [change] = diffSchema(pairwise, bbox, usage({ answers: stored }));
      expect(change).toMatchObject({
        impact: 'breaking',
        reason:
          'the kind cannot change once the project has 4 stored answers (3 submissions, 1 consensus answer)',
        affected: 4,
      });
    });
  });

  describe('field names', () => {
    const renames: Array<[string, object, object]> = [
      ['textField', classification, { ...classification, textField: 'body' }],
      ['textField', ner, { ...ner, textField: 'body' }],
      ['promptField', pairwise, { ...pairwise, promptField: 'question' }],
      ['responseAField', pairwise, { ...pairwise, responseAField: 'left' }],
      ['responseBField', pairwise, { ...pairwise, responseBField: 'right' }],
      ['imageField', bbox, { ...bbox, imageField: 'url' }],
    ];

    it.each(renames)('%s may change before the first import', (field, before, after) => {
      expect(diffSchema(before as never, after as never, usage({ answers: 3 }))).toEqual([
        expect.objectContaining({ field, impact: 'safe' }),
      ]);
    });

    it.each(renames)('%s is breaking once tasks exist', (field, before, after) => {
      // tasks and answers are separate checks: no answer is needed for this
      expect(diffSchema(before as never, after as never, usage({ tasks: 40 }))).toEqual([
        expect.objectContaining({ field, impact: 'breaking', affected: 40 }),
      ]);
    });

    it('says which field the tasks were imported with', () => {
      const after = { ...classification, textField: 'body' };
      expect(diffSchema(classification, after, usage({ tasks: 40 }))[0]).toMatchObject({
        summary: 'changed textField from “text” to “body”',
        reason: 'textField cannot change after 40 tasks were imported with “text”',
      });
    });

    it('treats swapped response fields as two breaking changes', () => {
      const after = { ...pairwise, responseAField: 'response_b', responseBField: 'response_a' };
      expect(
        breakingChanges(diffSchema(pairwise, after, usage({ tasks: 2 }))).map((c) => c.field),
      ).toEqual(['responseAField', 'responseBField']);
    });
  });

  describe('text classification', () => {
    const multi: TextClassificationSchema = { ...classification, multiple: true };

    it('lets labels be added and reordered', () => {
      const after = { ...classification, labels: ['spam', 'negative', 'neutral', 'positive'] };
      const used = usage({ tasks: 5, names: { positive: 3, neutral: 1, negative: 1 } });
      expect(impacts(diffSchema(classification, after, used))).toEqual([
        ['safe', 'added the label “spam”'],
        ['safe', 'reordered the labels'],
      ]);
    });

    it('lets an unused label be removed', () => {
      const after = { ...classification, labels: ['positive', 'negative'] };
      const used = usage({ tasks: 5, answers: 4, names: { positive: 3, negative: 1 } });
      expect(impacts(diffSchema(classification, after, used))).toEqual([
        ['safe', 'removed the label “neutral”'],
      ]);
    });

    it('refuses to remove a label that a stored answer uses', () => {
      const after = { ...classification, labels: ['positive', 'negative'] };
      const [change] = diffSchema(classification, after, usage({ names: { neutral: 12 } }));
      expect(change).toEqual({
        field: 'labels',
        impact: 'breaking',
        summary: 'removed the label “neutral”',
        reason:
          'the label “neutral” cannot be removed or renamed while 12 stored answers use it (12 submissions)',
        affected: 12,
      });
    });

    it('says in which places the answers are stored', () => {
      const after = { ...classification, labels: ['positive', 'negative'] };
      const where = {
        qualification: 1,
        dispute: 1,
        consensus: 3,
        gold: 1,
        correction: 1,
        submission: 2,
      };
      const [change] = diffSchema(classification, after, usage({ names: { neutral: where } }));
      expect(change.reason).toBe(
        'the label “neutral” cannot be removed or renamed while 9 stored answers use it ' +
          '(2 submissions, 1 reviewer correction, 1 gold answer, 3 consensus answers, ' +
          '1 disputed answer, 1 qualification answer)',
      );
      expect(change.affected).toBe(9);
    });

    it('sees a rename as a removal and an addition', () => {
      const after = { ...classification, labels: ['positive', 'mixed', 'negative'] };
      const used = usage({ names: { neutral: 1 } });
      expect(impacts(diffSchema(classification, after, used))).toEqual([
        ['breaking', 'removed the label “neutral”'],
        ['safe', 'added the label “mixed”'],
      ]);
      expect(diffSchema(classification, after, used)[0].reason).toBe(
        'the label “neutral” cannot be removed or renamed while 1 stored answer uses it (1 submission)',
      );
    });

    it('compares names exactly, so a change of case is a rename', () => {
      const after = { ...classification, labels: ['Positive', 'neutral', 'negative'] };
      const used = usage({ names: { positive: 2 } });
      expect(impacts(diffSchema(classification, after, used))).toEqual([
        ['breaking', 'removed the label “positive”'],
        ['safe', 'added the label “Positive”'],
      ]);
    });

    it('is not confused by labels named like object properties', () => {
      const before = { ...classification, labels: ['constructor', '__proto__', 'ok'] };
      const after = { ...classification, labels: ['ok', 'fine'] };
      // a Map, because `{ __proto__: 1 }` would not make a property at all
      const used = { ...NO_USAGE, names: new Map([['__proto__', { gold: 1 }]]) };
      expect(impacts(diffSchema(before, after, used))).toEqual([
        ['safe', 'removed the label “constructor”'],
        ['breaking', 'removed the label “__proto__”'],
        ['safe', 'added the label “fine”'],
      ]);
    });

    it('lets multiple be turned on, and off while no answer has two labels', () => {
      expect(impacts(diffSchema(classification, multi, usage({ answers: 9 })))).toEqual([
        ['safe', 'turned on “multiple”'],
      ]);
      expect(impacts(diffSchema(multi, classification, usage({ answers: 9 })))).toEqual([
        ['safe', 'turned off “multiple”'],
      ]);
    });

    it('refuses to turn multiple off when an answer has two labels', () => {
      const [change] = diffSchema(multi, classification, usage({ answers: 9, multiLabel: 2 }));
      expect(change).toMatchObject({
        field: 'multiple',
        impact: 'breaking',
        reason:
          '“multiple” cannot be turned off while 2 stored answers have more than one label (2 submissions)',
        affected: 2,
      });
    });
  });

  describe('named entities', () => {
    const after: NerSchema = {
      ...ner,
      entities: [
        { name: 'PERSON', color: '#111111' },
        { name: 'LOCATION', color: '#10b981' },
        { name: 'DATE' },
      ],
    };

    it('lets entity types be added, recoloured, and removed while unused', () => {
      const used = usage({ tasks: 3, names: { PERSON: 7, LOCATION: 2 } });
      expect(impacts(diffSchema(ner, after, used))).toEqual([
        ['safe', 'removed the entity type “ORG”'],
        ['safe', 'added the entity type “DATE”'],
        ['safe', 'changed the colour of “PERSON”'],
      ]);
    });

    it('refuses to remove an entity type that a stored span uses', () => {
      const changes = diffSchema(ner, after, usage({ names: { PERSON: 7, ORG: 5 } }));
      expect(breakingChanges(changes)).toEqual([
        {
          field: 'entities',
          impact: 'breaking',
          summary: 'removed the entity type “ORG”',
          reason:
            'the entity type “ORG” cannot be removed or renamed while 5 stored answers use it (5 submissions)',
          affected: 5,
        },
      ]);
    });
  });

  describe('pairwise', () => {
    const tone = { key: 'tone', label: 'Tone' };
    const withTone: PairwiseSchema = { ...pairwise, dimensions: [...pairwise.dimensions, tone] };
    const scored = { helpfulness: 14, accuracy: 14, safety: 14 };

    it('lets a dimension be added while no answer has scores', () => {
      // gold answers only hold a preference, so they do not count as scored
      const used = usage({ tasks: 6, answers: 2, scored: 0 });
      expect(impacts(diffSchema(pairwise, withTone, used))).toEqual([
        ['safe', 'added the rubric dimension “tone”'],
      ]);
    });

    it('refuses a new dimension once answers have scores', () => {
      const [change] = diffSchema(pairwise, withTone, usage({ scored: 14, dimensions: scored }));
      expect(change).toEqual({
        field: 'dimensions',
        impact: 'breaking',
        summary: 'added the rubric dimension “tone”',
        reason:
          'the rubric dimension “tone” cannot be added while 14 stored answers have no score for it (14 submissions)',
        affected: 14,
      });
    });

    it('names only the places whose answers lack the new dimension', () => {
      const used = usage({
        scored: { submission: 3, consensus: 2 },
        dimensions: { tone: { submission: 3 } },
      });
      expect(diffSchema(pairwise, withTone, used)[0]).toMatchObject({
        impact: 'breaking',
        reason:
          'the rubric dimension “tone” cannot be added while 2 stored answers have no score for it (2 consensus answers)',
        affected: 2,
      });
    });

    it('lets a removed dimension come back while every answer still has its scores', () => {
      const without = { ...pairwise, dimensions: pairwise.dimensions.slice(0, 2) };
      expect(
        impacts(diffSchema(without, pairwise, usage({ scored: 14, dimensions: scored }))),
      ).toEqual([['safe', 'added the rubric dimension “safety”']]);
      // one answer came in while the dimension was gone
      const later = usage({ scored: 15, dimensions: { ...scored, helpfulness: 15, accuracy: 15 } });
      expect(diffSchema(without, pairwise, later)[0]).toMatchObject({
        impact: 'breaking',
        reason:
          'the rubric dimension “safety” cannot be added while 1 stored answer has no score for it (1 submission)',
        affected: 1,
      });
    });

    it('warns when a removed dimension leaves scores behind', () => {
      const without = { ...pairwise, dimensions: pairwise.dimensions.slice(0, 2) };
      expect(diffSchema(pairwise, without, usage({ scored: 14, dimensions: scored }))).toEqual([
        {
          field: 'dimensions',
          impact: 'warning',
          summary: 'removed the rubric dimension “safety”',
          reason:
            'removing “safety” leaves its scores on 14 stored answers; the CSV export and new consensus answers leave them out',
          affected: 14,
        },
      ]);
      expect(impacts(diffSchema(pairwise, without, usage({ tasks: 3 })))).toEqual([
        ['safe', 'removed the rubric dimension “safety”'],
      ]);
    });

    it('sees a renamed key as a removal and an addition', () => {
      const after = {
        ...pairwise,
        dimensions: pairwise.dimensions.map((d) =>
          d.key === 'safety' ? { ...d, key: 'harm' } : d,
        ),
      };
      expect(
        impacts(diffSchema(pairwise, after, usage({ scored: 14, dimensions: scored }))),
      ).toEqual([
        ['warning', 'removed the rubric dimension “safety”'],
        ['breaking', 'added the rubric dimension “harm”'],
      ]);
    });

    it('lets dimensions be reworded and reordered', () => {
      const [first, second, third] = pairwise.dimensions;
      const after = {
        ...pairwise,
        dimensions: [second, { ...first, label: 'Usefulness' }, { ...third, description: 'New' }],
      };
      expect(
        impacts(diffSchema(pairwise, after, usage({ scored: 14, dimensions: scored }))),
      ).toEqual([
        ['safe', 'reworded the rubric dimension “helpfulness”'],
        ['safe', 'reworded the rubric dimension “safety”'],
        ['safe', 'reordered the rubric dimensions'],
      ]);
    });

    it('refuses to turn ties off when an answer is a tie', () => {
      const after = { ...pairwise, allowTie: false };
      expect(impacts(diffSchema(pairwise, after, usage({ answers: 8 })))).toEqual([
        ['safe', 'turned off “allowTie”'],
      ]);
      expect(diffSchema(pairwise, after, usage({ answers: 8, ties: 1 }))).toEqual([
        {
          field: 'allowTie',
          impact: 'breaking',
          summary: 'turned off “allowTie”',
          reason: '“allowTie” cannot be turned off while 1 stored answer is a tie (1 submission)',
          affected: 1,
        },
      ]);
      expect(impacts(diffSchema(after, pairwise, usage({ answers: 8 })))).toEqual([
        ['safe', 'turned on “allowTie”'],
      ]);
    });

    it('lets the rationale length change', () => {
      const after = { ...pairwise, minRationaleLength: 50 };
      const used = usage({ tasks: 9, answers: 9, scored: 9, dimensions: scored });
      expect(impacts(diffSchema(pairwise, after, used))).toEqual([
        ['safe', 'changed minRationaleLength from 20 to 50'],
      ]);
    });
  });

  describe('bounding boxes', () => {
    const after: BboxSchema = { ...bbox, labels: ['car', 'person', 'truck'], minBoxSize: 8 };

    it('lets box labels be added, the box size change, and unused labels go', () => {
      const used = usage({ tasks: 4, answers: 6, names: { car: 6, person: 2 } });
      expect(impacts(diffSchema(bbox, after, used))).toEqual([
        ['safe', 'removed the box label “bicycle”'],
        ['safe', 'added the box label “truck”'],
        ['safe', 'changed minBoxSize from 4 to 8'],
      ]);
    });

    it('refuses to remove a box label that a stored box uses', () => {
      const changes = diffSchema(bbox, after, usage({ names: { car: 6, bicycle: 1 } }));
      expect(breakingChanges(changes)).toEqual([
        {
          field: 'labels',
          impact: 'breaking',
          summary: 'removed the box label “bicycle”',
          reason:
            'the box label “bicycle” cannot be removed or renamed while 1 stored answer uses it (1 submission)',
          affected: 1,
        },
      ]);
    });
  });
});

describe('refusalMessage', () => {
  it('lists what breaks, counts the answers and points to Duplicate', () => {
    const multi = { ...classification, multiple: true };
    const after = { ...classification, labels: ['positive', 'negative'] };
    const breaking = breakingChanges(
      diffSchema(multi, after, usage({ names: { neutral: 12 }, multiLabel: 3 })),
    );
    expect(refusalMessage(breaking)).toBe(
      'Not saved. This would break work that already exists: ' +
        'the label “neutral” cannot be removed or renamed while 12 stored answers use it (12 submissions); ' +
        '“multiple” cannot be turned off while 3 stored answers have more than one label (3 submissions). ' +
        REDESIGN_HINT,
    );
    expect(REDESIGN_HINT).toContain('Duplicate project');
  });
});

describe('describeSchemaChange', () => {
  it('words the pair an activity entry keeps', () => {
    const after = { ...classification, labels: [...classification.labels, 'spam'], multiple: true };
    expect(describeSchemaChange([classification, after])).toEqual([
      'added the label “spam”',
      'turned on “multiple”',
    ]);
  });

  it('returns nothing for a pair it cannot read', () => {
    expect(describeSchemaChange(undefined)).toEqual([]);
    expect(describeSchemaChange([classification])).toEqual([]);
    expect(describeSchemaChange([classification, { kind: 'audio' }])).toEqual([]);
  });
});
