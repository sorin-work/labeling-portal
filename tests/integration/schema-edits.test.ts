import { beforeEach, describe, expect, it } from 'vitest';

import { REDESIGN_HINT, type SchemaUsage } from '~/domain/schema-diff';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';
import { schemaUsage } from '~/models/projects.server';
import { recordReview } from '~/models/reviews.server';
import { loader as activityLoader } from '~/routes/project-activity';
import { action as settingsAction, loader as settingsLoader } from '~/routes/project-settings';

import {
  cookieFor,
  createMember,
  createOrg,
  createTasks,
  createTestProject,
  makeRequest,
  payload,
  prisma,
  resetDb,
  run,
  statusOf,
  submitWork,
} from './helpers';

const sentiment = SCHEMA_TEMPLATES.text_classification;
const rubric = SCHEMA_TEMPLATES.pairwise;

type Saved = { saved: boolean; errors?: Record<string, string>; warnings: string[] };

/** A project with a manager who is signed in, and a way to post the settings form. */
async function setup(schema: object, status: 'DRAFT' | 'ACTIVE' = 'ACTIVE') {
  const org = await createOrg();
  const pm = await createMember(org.id, 'PROJECT_MANAGER', { name: 'Pat' });
  const ann = await createMember(org.id, 'ANNOTATOR');
  const project = await createTestProject(org.id, { schema, status, reviewRequired: false });
  const cookie = await cookieFor(pm, org.id);
  const path = `/projects/${project.id}/settings`;
  const save = (next: object, extra: Record<string, string> = {}) =>
    run(
      settingsAction,
      makeRequest(path, {
        cookie,
        form: {
          name: project.name,
          description: '',
          instructions: '',
          overlap: '1',
          timeLimitMinutes: '30',
          schema: JSON.stringify(next),
          ...extra,
        },
      }),
      { projectId: project.id },
    );
  const stored = async () =>
    (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).schema;
  return { org, pm, ann, project, cookie, path, save, stored };
}

const answerScores = (a: number, b: number) => ({
  a: { helpfulness: a, accuracy: a, safety: a },
  b: { helpfulness: b, accuracy: b, safety: b },
});

describe('schemaUsage', () => {
  beforeEach(resetDb);

  it('counts names in all five places that store answers', async () => {
    const schema = { ...sentiment, labels: ['a', 'b', 'c', 'd', 'e', 'f'], multiple: true };
    const { org, ann, project } = await setup(schema);
    const reviewer = await createMember(org.id, 'REVIEWER');
    const [t1, t2, t3] = await createTasks(project.id, [
      { text: '1' },
      { text: '2' },
      { text: '3' },
    ]);

    // Assignment.answer and Review.correctedAnswer; the fix completes the task
    // and writes Task.consensus
    const submission = await prisma.assignment.create({
      data: {
        projectId: project.id,
        taskId: t1.id,
        userId: ann.id,
        status: 'SUBMITTED',
        expiresAt: new Date(),
        answer: { labels: ['a', 'b'] },
        reviewStatus: 'PENDING',
      },
    });
    await recordReview(submission.id, reviewer.id, {
      decision: 'FIX',
      qaScore: 3,
      feedback: '',
      correctedAnswer: { labels: ['c'] },
    });
    // Task.goldAnswer
    await prisma.task.update({
      where: { id: t2.id },
      data: { isGold: true, goldAnswer: { labels: ['d'] } },
    });
    // QualificationAttempt.answers is kept as it was posted. Only the entry
    // of a test question counts, and a label posted twice is one label. The
    // rest of the map was never validated: an entry under a made-up key or
    // under the id of a regular task, and values that are not answers
    await prisma.task.update({ where: { id: t3.id }, data: { isQualification: true } });
    await prisma.qualificationAttempt.create({
      data: {
        projectId: project.id,
        userId: ann.id,
        scorePercent: 0,
        passed: false,
        answers: {
          [t3.id]: { labels: ['e', 'e'] },
          extra: { labels: ['f', 'a'] },
          [t1.id]: { labels: ['f', 'b'] },
          junk: 'text',
          more: ['f'],
          none: null,
        },
      },
    });
    // a claim without an answer, and another project's work, are not counted
    await prisma.assignment.create({
      data: { projectId: project.id, taskId: t2.id, userId: ann.id, expiresAt: new Date() },
    });
    const other = await createTestProject(org.id, { schema, reviewRequired: false });
    await createTasks(other.id, [{ text: 'x' }]);
    await submitWork(other, ann.id, { labels: ['f'] });

    expect(await schemaUsage(project.id)).toEqual({
      tasks: 3,
      answers: 5,
      names: new Map([
        ['a', 1],
        ['b', 1],
        ['c', 2],
        ['d', 1],
        ['e', 1],
      ]),
      multiLabel: 1,
      ties: 0,
      scored: 0,
      dimensions: new Map(),
    } satisfies SchemaUsage);
  });

  it('counts ties and rubric scores of pairwise answers', async () => {
    const { ann, project } = await setup(rubric);
    const row = { prompt: 'p', response_a: 'a', response_b: 'b' };
    const [t1, t2, t3] = await createTasks(project.id, [row, row, row]);
    const rationale = 'A is clearer and more complete.';
    const submitted = (taskId: string, answer: object) =>
      prisma.assignment.create({
        data: {
          projectId: project.id,
          taskId,
          userId: ann.id,
          status: 'SUBMITTED',
          expiresAt: new Date(),
          answer,
        },
      });
    await submitted(t1.id, { preference: 'A', scores: answerScores(4, 2), rationale });
    await submitted(t2.id, { preference: 'tie', scores: answerScores(3, 3), rationale });
    // an answer from before "safety" was added to the rubric
    await submitted(t3.id, {
      preference: 'B',
      scores: { a: { helpfulness: 2, accuracy: 2 }, b: { helpfulness: 5, accuracy: 4 } },
      rationale,
    });
    // a gold answer is a preference without scores
    await prisma.task.update({
      where: { id: t3.id },
      data: {
        isGold: true,
        goldAnswer: { preference: 'tie', scores: { a: {}, b: {} }, rationale: '' },
      },
    });

    expect(await schemaUsage(project.id)).toEqual({
      tasks: 3,
      answers: 4,
      names: new Map(),
      multiLabel: 0,
      ties: 2,
      scored: 3,
      dimensions: new Map([
        ['helpfulness', 3],
        ['accuracy', 3],
        ['safety', 2],
      ]),
    } satisfies SchemaUsage);
  });

  it('counts an entity type or box label once per answer', async () => {
    const { org, ann, project } = await setup(SCHEMA_TEMPLATES.ner);
    await createTasks(project.id, [{ text: 'Ada met Grace in Paris.' }]);
    await submitWork(project, ann.id, {
      spans: [
        { start: 0, end: 3, label: 'PERSON' },
        { start: 8, end: 13, label: 'PERSON' },
        { start: 17, end: 22, label: 'LOCATION' },
      ],
    });
    // consensus repeats the single accepted answer
    expect((await schemaUsage(project.id)).names).toEqual(
      new Map([
        ['PERSON', 2],
        ['LOCATION', 2],
      ]),
    );

    const boxes = await createTestProject(org.id, {
      schema: SCHEMA_TEMPLATES.bbox,
      reviewRequired: true,
    });
    await createTasks(boxes.id, [{ image_url: '/street.jpg' }]);
    await submitWork(boxes, ann.id, {
      imageWidth: 100,
      imageHeight: 100,
      boxes: [
        { x: 0, y: 0, w: 10, h: 10, label: 'car' },
        { x: 50, y: 50, w: 10, h: 10, label: 'car' },
      ],
    });
    expect((await schemaUsage(boxes.id)).names).toEqual(new Map([['car', 1]]));
  });
});

describe('schema edits once work exists', () => {
  beforeEach(resetDb);

  it('refuses to remove a label that stored answers use, and saves nothing', async () => {
    const { ann, project, save, stored, cookie, path } = await setup(sentiment);
    await createTasks(project.id, [{ text: 'one' }, { text: 'two' }]);
    await submitWork(project, ann.id, { labels: ['neutral'] });

    // the action decides from the database, whatever the page showed
    const result = await save(
      { ...sentiment, labels: ['positive', 'negative'] },
      { name: 'Renamed in the same post' },
    );

    expect(statusOf(result)).toBe(400);
    const body = payload<Saved>(result);
    expect(body.saved).toBe(false);
    // the submission and the consensus it produced both use the label
    expect(body.errors?.schema).toBe(
      'Not saved. This would break work that already exists: ' +
        'the label “neutral” cannot be removed or renamed while 2 stored answers use it. ' +
        REDESIGN_HINT,
    );
    expect(await stored()).toEqual(sentiment);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.name).toBe(project.name);
    expect(await prisma.activity.count()).toBe(0);

    // the page gets the counts, so the form can show the same before a save
    const page = payload<{ usage: SchemaUsage }>(
      await run(settingsLoader, makeRequest(path, { cookie }), { projectId: project.id }),
    );
    expect(page.usage.names.get('neutral')).toBe(2);
    expect(page.usage.tasks).toBe(2);
  });

  it('saves safe edits and records the schema before and after', async () => {
    const { ann, project, save, stored, cookie } = await setup(sentiment);
    await createTasks(project.id, [{ text: 'one' }]);
    await submitWork(project, ann.id, { labels: ['positive'] });
    // "neutral" is not used by any answer, so it may go
    const next = { ...sentiment, labels: ['positive', 'negative', 'spam'], multiple: true };

    const result = await save(next);

    expect(payload<Saved>(result)).toEqual({ errors: undefined, saved: true, warnings: [] });
    expect(await stored()).toEqual(next);
    const entry = await prisma.activity.findFirstOrThrow({ where: { projectId: project.id } });
    expect(entry.action).toBe('project.settings');
    expect(entry.detail).toEqual({ changes: { schema: [sentiment, next] } });

    const activity = await run(
      activityLoader,
      makeRequest(`/projects/${project.id}/activity`, { cookie }),
      { projectId: project.id },
    );
    expect(payload<{ entries: Array<{ actor: string; text: string }> }>(activity).entries).toEqual([
      expect.objectContaining({
        actor: 'Pat',
        text:
          'changed the task schema: removed the label “neutral”, added the label “spam”, ' +
          'turned on “multiple”',
      }),
    ]);
  });

  it('records no schema change when the schema was not edited', async () => {
    const { ann, project, save } = await setup(sentiment);
    await createTasks(project.id, [{ text: 'one' }]);
    await submitWork(project, ann.id, { labels: ['neutral'] });

    const result = await save(sentiment, { name: 'New name', rate: '0.25' });

    expect(payload<Saved>(result).saved).toBe(true);
    const entry = await prisma.activity.findFirstOrThrow({ where: { projectId: project.id } });
    expect(entry.detail).toBeNull();
    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({
      name: 'New name',
      rateCents: 25,
    });
  });

  it('refuses a field rename or another kind once tasks exist, even without answers', async () => {
    const { project, save, stored } = await setup(sentiment, 'DRAFT');

    // an empty project may still be redesigned
    const renamed = { ...sentiment, textField: 'body' };
    expect(payload<Saved>(await save(renamed)).saved).toBe(true);
    await createTasks(project.id, [{ body: 'one' }, { body: 'two' }]);

    const field = await save(sentiment);
    expect(statusOf(field)).toBe(400);
    expect(payload<Saved>(field).errors?.schema).toContain(
      'textField cannot change after 2 tasks were imported with “body”',
    );

    const kind = await save(SCHEMA_TEMPLATES.bbox);
    expect(statusOf(kind)).toBe(400);
    expect(payload<Saved>(kind).errors?.schema).toContain(
      'the kind cannot change once the project has 2 tasks',
    );

    expect(await stored()).toEqual(renamed);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({
      kind: 'TEXT_CLASSIFICATION',
    });
  });

  it('lets an empty project change its kind', async () => {
    const { project, save, stored } = await setup(sentiment, 'DRAFT');

    expect(payload<Saved>(await save(SCHEMA_TEMPLATES.bbox)).saved).toBe(true);

    expect(await stored()).toEqual(SCHEMA_TEMPLATES.bbox);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({
      kind: 'BBOX',
    });
  });

  it('refuses to turn off multiple labels while an answer has two', async () => {
    const multi = { ...sentiment, multiple: true };
    const { ann, project, save, stored } = await setup(multi);
    await createTasks(project.id, [{ text: 'one' }, { text: 'two' }]);
    await submitWork(project, ann.id, { labels: ['positive'] });

    // one label per answer so far: single choice still fits every answer
    expect(payload<Saved>(await save(sentiment)).saved).toBe(true);
    expect(payload<Saved>(await save(multi)).saved).toBe(true);

    await submitWork(project, ann.id, { labels: ['positive', 'neutral'] });
    const result = await save(sentiment);
    expect(statusOf(result)).toBe(400);
    expect(payload<Saved>(result).errors?.schema).toContain(
      '“multiple” cannot be turned off while 2 stored answers have more than one label',
    );
    expect(await stored()).toEqual(multi);
  });

  it('is not blocked by what a hand-made test attempt adds to its answers', async () => {
    const multi = { ...sentiment, multiple: true };
    const { ann, project, save, stored } = await setup(multi);
    const [question] = await createTasks(project.id, [{ text: 'one' }]);
    await prisma.task.update({
      where: { id: question.id },
      data: { isQualification: true, goldAnswer: { labels: ['positive'] } },
    });
    // the answer to the question was validated, the extra entry never was
    await prisma.qualificationAttempt.create({
      data: {
        projectId: project.id,
        userId: ann.id,
        scorePercent: 100,
        passed: true,
        answers: {
          [question.id]: { labels: ['positive'] },
          extra: { labels: ['neutral', 'negative'] },
        },
      },
    });

    const next = { ...sentiment, labels: ['positive', 'other'] };
    expect(payload<Saved>(await save(next)).saved).toBe(true);
    expect(await stored()).toEqual(next);

    // the validated answer still counts
    const result = await save({ ...next, labels: ['other', 'another'] });
    expect(statusOf(result)).toBe(400);
    expect(payload<Saved>(result).errors?.schema).toContain(
      'the label “positive” cannot be removed',
    );
  });

  it('refuses a new rubric dimension and ties turned off, and warns about a removed one', async () => {
    const { ann, project, save, stored } = await setup(rubric);
    const row = { prompt: 'p', response_a: 'a', response_b: 'b' };
    const [, gold] = await createTasks(project.id, [row, row]);
    await prisma.task.update({
      where: { id: gold.id },
      data: {
        isGold: true,
        goldAnswer: { preference: 'tie', scores: { a: {}, b: {} }, rationale: '' },
      },
    });
    await submitWork(project, ann.id, {
      preference: 'A',
      scores: answerScores(4, 2),
      rationale: 'A is clearer and more complete.',
    });

    const tone = { key: 'tone', label: 'Tone' };
    const added = await save({ ...rubric, dimensions: [...rubric.dimensions, tone] });
    expect(statusOf(added)).toBe(400);
    // the submission and its consensus have scores; the gold answer has none
    expect(payload<Saved>(added).errors?.schema).toContain(
      'the rubric dimension “tone” cannot be added while 2 stored answers have no score for it',
    );

    // only the gold answer is a tie, and that is enough
    const noTies = await save({ ...rubric, allowTie: false });
    expect(statusOf(noTies)).toBe(400);
    expect(payload<Saved>(noTies).errors?.schema).toContain(
      '“allowTie” cannot be turned off while 1 stored answer is a tie',
    );
    expect(await stored()).toEqual(rubric);

    const shorter = { ...rubric, dimensions: rubric.dimensions.slice(0, 2), minRationaleLength: 5 };
    const removed = await save(shorter);
    expect(payload<Saved>(removed)).toEqual({
      errors: undefined,
      saved: true,
      warnings: [
        'removing “safety” leaves its scores on 2 stored answers; the CSV export and new consensus answers leave them out',
      ],
    });
    expect(await stored()).toEqual(shorter);

    // nothing was submitted in between, so the dimension can come back
    expect(payload<Saved>(await save({ ...rubric, minRationaleLength: 5 })).saved).toBe(true);
  });
});
