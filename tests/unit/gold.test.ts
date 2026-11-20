import { describe, expect, it } from 'vitest';

import {
  describeGoldAnswer,
  goldFeedback,
  goldImpact,
  goldStanding,
  isGoldFlagged,
  parseGoldReason,
  rescore,
  sameAnswer,
  scoreAgainstGold,
} from '~/domain/gold';
import { diffSchema } from '~/domain/schema-diff';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';

describe('scoreAgainstGold', () => {
  it('scores classification by label overlap', () => {
    const schema = { ...SCHEMA_TEMPLATES.text_classification, multiple: true };
    expect(scoreAgainstGold(schema, { labels: ['positive'] }, { labels: ['positive'] })).toBe(1);
    expect(scoreAgainstGold(schema, { labels: ['positive'] }, { labels: ['negative'] })).toBe(0);
    expect(
      scoreAgainstGold(schema, { labels: ['positive', 'neutral'] }, { labels: ['positive'] }),
    ).toBe(0.5);
  });

  it('scores entities with span f1', () => {
    const gold = {
      spans: [
        { start: 0, end: 5, label: 'PERSON' },
        { start: 10, end: 15, label: 'ORG' },
      ],
    };
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.ner, gold, gold)).toBe(1);
    expect(
      scoreAgainstGold(
        SCHEMA_TEMPLATES.ner,
        { spans: [{ start: 0, end: 5, label: 'PERSON' }] },
        gold,
      ),
    ).toBe(0.6667);
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.ner, { spans: [] }, { spans: [] })).toBe(1);
  });

  it('gives half credit for ties in pairwise preferences', () => {
    const vote = (preference: 'A' | 'B' | 'tie') => ({
      preference,
      scores: { a: {}, b: {} },
      rationale: '',
    });
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.pairwise, vote('A'), vote('A'))).toBe(1);
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.pairwise, vote('tie'), vote('A'))).toBe(0.5);
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.pairwise, vote('B'), vote('A'))).toBe(0);
  });

  it('never scores above 1 when gold boxes overlap', () => {
    const img = { imageWidth: 200, imageHeight: 200 };
    const gold = {
      ...img,
      boxes: [
        { x: 10, y: 10, w: 60, h: 40, label: 'car' },
        { x: 20, y: 10, w: 60, h: 40, label: 'car' },
      ],
    };
    const one = { ...img, boxes: [{ x: 15, y: 10, w: 60, h: 40, label: 'car' }] };
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.bbox, one, gold)).toBe(0.6667);
  });

  it('scores boxes with box f1', () => {
    const img = { imageWidth: 200, imageHeight: 200 };
    const gold = {
      ...img,
      boxes: [
        { x: 10, y: 10, w: 40, h: 40, label: 'car' },
        { x: 120, y: 120, w: 30, h: 60, label: 'person' },
      ],
    };
    const answer = {
      ...img,
      boxes: [
        { x: 12, y: 11, w: 40, h: 38, label: 'car' },
        { x: 150, y: 10, w: 20, h: 20, label: 'person' },
      ],
    };
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.bbox, gold, gold)).toBe(1);
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.bbox, answer, gold)).toBe(0.5);
  });
});

describe('isGoldFlagged', () => {
  it('flags accuracy under the pass score after three gold tasks', () => {
    expect(isGoldFlagged(0.5, 3)).toBe(true);
    expect(isGoldFlagged(0.5, 2)).toBe(false);
    expect(isGoldFlagged(0.8, 10)).toBe(false);
    expect(isGoldFlagged(null, 0)).toBe(false);
  });
});

describe('sameAnswer', () => {
  it('compares stored answers whatever order their keys are in', () => {
    expect(sameAnswer({ labels: ['a', 'b'] }, { labels: ['a', 'b'] })).toBe(true);
    expect(sameAnswer({ labels: ['a', 'b'] }, { labels: ['b', 'a'] })).toBe(false);
    expect(sameAnswer({ x: 1, y: { z: [1] } }, { y: { z: [1] }, x: 1 })).toBe(true);
    expect(sameAnswer({ x: 1 }, { x: 1, y: 2 })).toBe(false);
    expect(sameAnswer({ x: [] }, { x: {} })).toBe(false);
    expect(sameAnswer(null, {})).toBe(false);
  });
});

describe('describeGoldAnswer', () => {
  it('says the answer in a few words for every kind', () => {
    expect(describeGoldAnswer(SCHEMA_TEMPLATES.text_classification, { labels: ['positive'] })).toBe(
      'positive',
    );
    expect(
      describeGoldAnswer(SCHEMA_TEMPLATES.ner, {
        spans: [
          { start: 0, end: 2, label: 'PERSON' },
          { start: 3, end: 5, label: 'PERSON' },
          { start: 6, end: 9, label: 'ORG' },
        ],
      }),
    ).toBe('2 PERSON, 1 ORG');
    expect(describeGoldAnswer(SCHEMA_TEMPLATES.pairwise, { preference: 'B' })).toBe('response B');
    expect(describeGoldAnswer(SCHEMA_TEMPLATES.pairwise, { preference: 'tie' })).toBe('a tie');
    expect(describeGoldAnswer(SCHEMA_TEMPLATES.bbox, { boxes: [] })).toBe('no boxes');
    expect(describeGoldAnswer(SCHEMA_TEMPLATES.bbox, null)).toBe('nothing');
  });
});

describe('rescore', () => {
  const schema = SCHEMA_TEMPLATES.text_classification;
  const submissions = [
    { assignmentId: 'a1', userId: 'ann', answer: { labels: ['positive'] }, goldScore: 1 },
    { assignmentId: 'a2', userId: 'ben', answer: { labels: ['negative'] }, goldScore: 0 },
    { assignmentId: 'a3', userId: 'cy', answer: { labels: ['negative'] }, goldScore: null },
    { assignmentId: 'a4', userId: 'di', answer: null, goldScore: null },
  ];

  it('returns only the scores that differ from what is stored', () => {
    expect(rescore(schema, { labels: ['positive'] }, submissions)).toEqual([
      { assignmentId: 'a3', userId: 'cy', from: null, to: 0 },
    ]);
    expect(rescore(schema, { labels: ['negative'] }, submissions)).toEqual([
      { assignmentId: 'a1', userId: 'ann', from: 1, to: 0 },
      { assignmentId: 'a2', userId: 'ben', from: 0, to: 1 },
      { assignmentId: 'a3', userId: 'cy', from: null, to: 1 },
    ]);
  });

  it('changes nothing the second time', () => {
    const gold = { labels: ['negative'] };
    const changes = new Map(rescore(schema, gold, submissions).map((c) => [c.assignmentId, c.to]));
    const applied = submissions.map((s) => ({
      ...s,
      goldScore: changes.get(s.assignmentId) ?? s.goldScore,
    }));
    expect(rescore(schema, gold, applied)).toEqual([]);
  });
});

describe('goldStanding and goldImpact', () => {
  it('needs three gold tasks before low accuracy flags someone', () => {
    expect(goldStanding([])).toEqual({ attempts: 0, accuracy: null, flagged: false });
    expect(goldStanding([0, 0])).toEqual({ attempts: 2, accuracy: 0, flagged: false });
    expect(goldStanding([1, 1, 0])).toEqual({ attempts: 3, accuracy: 0.6667, flagged: true });
    expect(goldStanding([1, 1, 1, 1, 0])).toEqual({ attempts: 5, accuracy: 0.8, flagged: false });
  });

  it('lists who moves and who crosses the flag, in both directions', () => {
    const before = new Map([
      ['ann', [1, 1, 1]],
      ['ben', [0, 1, 1]],
      ['cy', [1, 1]],
    ]);
    const after = new Map([
      ['ann', [0, 1, 1]],
      ['ben', [1, 1, 1]],
      ['cy', [1, 1]],
    ]);
    const impact = goldImpact(before, after);
    expect(impact.moved.map((m) => m.userId).sort()).toEqual(['ann', 'ben']);
    expect(impact.newlyFlagged).toEqual(['ann']);
    expect(impact.noLongerFlagged).toEqual(['ben']);
  });

  it('counts a task that stops counting as a move', () => {
    const impact = goldImpact(new Map([['ann', [0, 1, 1]]]), new Map([['ann', [1, 1]]]));
    expect(impact.moved).toEqual([
      {
        userId: 'ann',
        before: { attempts: 3, accuracy: 0.6667, flagged: true },
        after: { attempts: 2, accuracy: 1, flagged: false },
      },
    ]);
    expect(impact.noLongerFlagged).toEqual(['ann']);
  });
});

describe('parseGoldReason', () => {
  it('needs a reason of a sensible length', () => {
    expect(parseGoldReason('  ').ok).toBe(false);
    expect(parseGoldReason(null).ok).toBe(false);
    expect(parseGoldReason('x'.repeat(501)).ok).toBe(false);
    expect(parseGoldReason(' The review is sarcastic. ')).toEqual({
      ok: true,
      reason: 'The review is sarcastic.',
    });
  });
});

describe('goldFeedback', () => {
  const schema = SCHEMA_TEMPLATES.text_classification;
  const submission = {
    status: 'SUBMITTED',
    answer: { labels: ['negative'] },
    goldScore: 0,
    task: { isGold: true, goldAnswer: { labels: ['positive'] }, goldRetiredAt: null },
    project: { goldFeedback: true },
  };

  it('shows the score and the expected answer of a submitted gold task', () => {
    expect(goldFeedback(submission, schema)).toEqual({
      score: 0,
      expected: { labels: ['positive'] },
    });
  });

  it('shows nothing before the work is submitted, or when the project hides it', () => {
    expect(goldFeedback({ ...submission, status: 'ACTIVE' }, schema)).toBeNull();
    expect(goldFeedback({ ...submission, project: { goldFeedback: false } }, schema)).toBeNull();
  });

  it('shows nothing for other tasks, retired gold or unscored work', () => {
    const { task } = submission;
    expect(goldFeedback({ ...submission, task: { ...task, isGold: false } }, schema)).toBeNull();
    expect(
      goldFeedback({ ...submission, task: { ...task, goldRetiredAt: new Date() } }, schema),
    ).toBeNull();
    expect(goldFeedback({ ...submission, goldScore: null }, schema)).toBeNull();
  });

  it('shows nothing while the stored score belongs to an earlier expected answer', () => {
    // the expected answer became "negative" and the rescore has not run: the
    // stored 0 would read as "you said negative, expected negative, 0%"
    const edited = { ...submission.task, goldAnswer: { labels: ['negative'] } };
    expect(goldFeedback({ ...submission, task: edited }, schema)).toBeNull();
    expect(goldFeedback({ ...submission, task: edited, goldScore: 1 }, schema)).toEqual({
      score: 1,
      expected: { labels: ['negative'] },
    });
  });
});

describe('a label held by the history of a gold task', () => {
  const before = SCHEMA_TEMPLATES.text_classification;
  const [gone, ...kept] = before.labels;
  const usage = {
    tasks: 5,
    answers: 4,
    names: new Map([[gone, 3]]),
    multiLabel: 0,
    ties: 0,
    scored: 0,
    dimensions: new Map<string, number>(),
  };
  const reason = (goldHistory?: Map<string, number>) =>
    diffSchema(before, { ...before, labels: kept }, { ...usage, goldHistory }).find(
      (change) => change.impact === 'breaking',
    )?.reason;

  it('is named in the refusal, because that history never goes away', () => {
    expect(reason()).toBe(
      `the label “${gone}” cannot be removed or renamed while 3 stored answers use it`,
    );
    expect(reason(new Map([[gone, 2]]))).toBe(
      `the label “${gone}” cannot be removed or renamed while 3 stored answers use it, 2 of them in the history of a gold task whose expected answer was changed; that history is kept for good`,
    );
    expect(reason(new Map([[gone, 3]]))).toMatch(
      /use it, all of them in the history of a gold task/,
    );
  });
});
