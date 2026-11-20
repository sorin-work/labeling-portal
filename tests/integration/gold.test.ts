import { beforeEach, describe, expect, it } from 'vitest';

import { myStats } from '~/models/annotator-stats.server';
import { listBatches } from '~/models/batches.server';
import { applyRescore, promoteToGold, setGoldRetired } from '~/models/gold.server';
import { payoutReport } from '~/models/payouts.server';
import { schemaUsage } from '~/models/projects.server';
import { isAnnotatorFlagged, projectQuality } from '~/models/quality.server';
import { claimNextTask, submitAssignment } from '~/models/queue.server';
import { action as batchAction } from '~/routes/batch-detail';
import { loader as reviseLoader } from '~/routes/my-work-revise';
import { loader as myWorkLoader } from '~/routes/my-work';
import { loader as activityLoader } from '~/routes/project-activity';
import { loader as downloadLoader } from '~/routes/project-download';
import { loader as qualityLoader } from '~/routes/project-quality';
import { action as settingsAction } from '~/routes/project-settings';
import { action as taskAction, loader as taskLoader } from '~/routes/task-detail';
import { loader as workLoader } from '~/routes/work';

import {
  addToProject,
  cookieFor,
  createMember,
  createOrg,
  createTasks,
  createTestProject,
  locationOf,
  makeRequest,
  payload,
  prisma,
  resetDb,
  run,
  statusOf,
  submitWork,
} from './helpers';

async function setup() {
  const org = await createOrg();
  const project = await createTestProject(org.id, { overlap: 1 });
  const batch = await prisma.batch.create({
    data: { projectId: project.id, name: 'b', format: 'CSV' },
  });
  const gold = await prisma.task.create({
    data: {
      projectId: project.id,
      batchId: batch.id,
      position: 1,
      data: { text: 'I love it' },
      isGold: true,
      goldAnswer: { labels: ['positive'] },
    },
  });
  await prisma.task.create({
    data: { projectId: project.id, batchId: batch.id, position: 2, data: { text: 'regular' } },
  });
  return { org, project, gold };
}

describe('gold accuracy in quality stats', () => {
  beforeEach(resetDb);

  it('averages gold scores per annotator', async () => {
    const { org, project } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
    await submitWork(project, ann.id, { labels: ['negative'] });
    const { projectQuality } = await import('~/models/quality.server');
    const quality = await projectQuality(project);
    expect(quality.annotators[0]).toMatchObject({
      goldAttempts: 1,
      goldAccuracy: 0,
      flagged: false,
    });
  });
});

describe('gold tasks', () => {
  beforeEach(resetDb);

  it('scores gold submissions without sending them to review', async () => {
    const { org, project, gold } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR');

    const right = await submitWork(project, ann.id, { labels: ['positive'] });
    expect(right).toMatchObject({ taskId: gold.id, goldScore: 1, reviewStatus: 'NOT_REQUIRED' });

    const other = await createMember(org.id, 'ANNOTATOR');
    const wrong = await submitWork(project, other.id, { labels: ['negative'] });
    expect(wrong).toMatchObject({ taskId: gold.id, goldScore: 0 });
  });

  it('shows a gold task to every annotator regardless of overlap and never completes it', async () => {
    const { org, project, gold } = await setup();
    for (let i = 0; i < 3; i++) {
      const user = await createMember(org.id, 'ANNOTATOR');
      await submitWork(project, user.id, { labels: ['positive'] });
    }
    expect(await prisma.assignment.count({ where: { taskId: gold.id } })).toBe(3);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: gold.id } })).status).toBe('OPEN');
  });

  it('does not offer the same gold task twice to one person', async () => {
    const { org, project, gold } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR');
    await submitWork(project, ann.id, { labels: ['positive'] });
    const next = await claimNextTask(project, ann.id);
    expect(next.ok && next.assignment.taskId).not.toBe(gold.id);
  });
});

describe('my stats', () => {
  beforeEach(resetDb);

  it('summarises an annotator’s last 30 days', async () => {
    const { org, project } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR');
    await submitWork(project, ann.id, { labels: ['positive'] }, { activeSeconds: 1800 });
    await submitWork(project, ann.id, { labels: ['negative'] }, { activeSeconds: 1800 });
    const { myStats } = await import('~/models/annotator-stats.server');
    const stats = await myStats(ann.id);
    expect(stats).toMatchObject({ submitted: 2, accepted: 1, goldAccuracy: 1, acceptanceRate: 1 });
  });
});

const SENTIMENT = {
  kind: 'text_classification',
  textField: 'text',
  labels: ['positive', 'negative', 'neutral'],
  multiple: false,
};

/**
 * A project without review, three gold tasks first in the queue and some
 * regular tasks behind them. The first gold task carries a wrong expected
 * answer: the text is negative, the gold says positive.
 */
async function goldProject(regular = 2) {
  const org = await createOrg();
  const project = await createTestProject(org.id, { schema: SENTIMENT, reviewRequired: false });
  const tasks = await createTasks(project.id, [
    { text: 'This is the worst purchase I ever made' },
    { text: 'Lovely, would buy again' },
    { text: 'Broke after a day' },
    ...Array.from({ length: regular }, (_, i) => ({ text: `regular ${i}` })),
  ]);
  const expected = ['positive', 'positive', 'negative'];
  for (const [i, label] of expected.entries()) {
    await prisma.task.update({
      where: { id: tasks[i].id },
      data: { isGold: true, goldAnswer: { labels: [label] } },
    });
  }
  const pm = await createMember(org.id, 'PROJECT_MANAGER', { name: 'Priya' });
  const reviewer = await createMember(org.id, 'REVIEWER', { name: 'Rafael' });
  await addToProject(project.id, reviewer);
  const pmCookie = await cookieFor(pm, org.id);
  const path = (taskId: string) => `/projects/${project.id}/tasks/${taskId}`;
  const post = (taskId: string, form: Record<string, string>, cookie = pmCookie) =>
    run(taskAction, makeRequest(path(taskId), { cookie, form }), {
      projectId: project.id,
      taskId,
    });
  const view = (taskId: string, cookie = pmCookie) =>
    run(taskLoader, makeRequest(path(taskId), { cookie }), { projectId: project.id, taskId });
  return {
    org,
    project,
    gold: tasks.slice(0, 3),
    regular: tasks.slice(3),
    pm,
    reviewer,
    pmCookie,
    reviewerCookie: await cookieFor(reviewer, org.id),
    post,
    view,
  };
}

type GoldSetup = Awaited<ReturnType<typeof goldProject>>;

/** An annotator who answers the three gold tasks with these labels, in queue order. */
async function answersGold(s: GoldSetup, name: string, labels: string[]) {
  const user = await createMember(s.org.id, 'ANNOTATOR', { name });
  await addToProject(s.project.id, user);
  for (const label of labels) await submitWork(s.project, user.id, { labels: [label] });
  return user;
}

const scoresOf = async (userId: string) =>
  (
    await prisma.assignment.findMany({
      where: { userId, goldScore: { not: null } },
      orderBy: { task: { position: 'asc' } },
      select: { goldScore: true },
    })
  ).map((a) => a.goldScore);

const editForm = (label: string, reason = 'The text is clearly negative.') => ({
  intent: 'gold-edit',
  gold: JSON.stringify({ labels: [label] }),
  reason,
});

type GoldView = {
  gold: {
    answer: unknown;
    revisions: Array<Record<string, unknown>>;
    rescore: {
      submissions: number;
      changes: unknown[];
      impact: { moved: unknown[]; newlyFlagged: string[]; noLongerFlagged: string[] };
    } | null;
  } | null;
  task: { isGold: boolean };
  assignments: Array<{ goldScore: number | null }>;
};

describe('changing a gold answer', () => {
  beforeEach(resetDb);

  it('keeps the old answer and leaves every score alone until the rescore', async () => {
    const s = await goldProject();
    const ann = await answersGold(s, 'Ann', ['positive', 'positive', 'negative']);
    const ben = await answersGold(s, 'Ben', ['negative', 'positive', 'negative']);
    expect(await scoresOf(ann.id)).toEqual([1, 1, 1]);
    expect(await scoresOf(ben.id)).toEqual([0, 1, 1]);
    expect(await isAnnotatorFlagged(s.project.id, ben.id)).toBe(true);
    const [wrong] = s.gold;

    const saved = await s.post(wrong.id, editForm('negative'));
    expect(locationOf(saved)).toBe(`/projects/${s.project.id}/tasks/${wrong.id}`);

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: wrong.id },
      include: { goldRevisions: true },
    });
    expect(task.goldAnswer).toEqual({ labels: ['negative'] });
    expect(task.goldRevisions).toMatchObject([
      {
        change: 'EDITED',
        previousAnswer: { labels: ['positive'] },
        answer: { labels: ['negative'] },
        reason: 'The text is clearly negative.',
        changedById: s.pm.id,
      },
    ]);
    // nothing was rescored behind the manager's back
    expect(await scoresOf(ann.id)).toEqual([1, 1, 1]);
    expect(await scoresOf(ben.id)).toEqual([0, 1, 1]);

    // the page says what a rescore would do before anyone applies it
    const page = payload<GoldView>(await s.view(wrong.id));
    expect(page.gold?.rescore).toMatchObject({ submissions: 2 });
    expect(page.gold?.rescore?.changes).toHaveLength(2);
    expect(page.gold?.rescore?.impact).toMatchObject({
      newlyFlagged: [ann.id],
      noLongerFlagged: [ben.id],
    });
    expect(page.gold?.revisions).toMatchObject([
      { change: 'EDITED', by: 'Priya', from: 'positive', to: 'negative' },
    ]);
  });

  it('rescores in one step, the same twice, and never touches accepted work or pay', async () => {
    const s = await goldProject();
    const ann = await answersGold(s, 'Ann', ['positive', 'positive', 'negative']);
    const ben = await answersGold(s, 'Ben', ['negative', 'positive', 'negative']);
    const [wrong] = s.gold;
    await s.post(wrong.id, editForm('negative'));
    const day = new Date().toISOString().slice(0, 10);
    const paidBefore = await payoutReport(s.org.id, { from: '2020-01-01', to: day });
    const acceptedBefore = await prisma.assignment.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, status: true, reviewStatus: true, answer: true, submittedAt: true },
    });

    expect(statusOf(await s.post(wrong.id, { intent: 'gold-rescore' }))).toBe(302);
    expect(await scoresOf(ann.id)).toEqual([0, 1, 1]);
    expect(await scoresOf(ben.id)).toEqual([1, 1, 1]);
    // what gates on the scores follows: the flag, and with it who is always reviewed
    expect(await isAnnotatorFlagged(s.project.id, ann.id)).toBe(true);
    expect(await isAnnotatorFlagged(s.project.id, ben.id)).toBe(false);
    const quality = await projectQuality(s.project);
    expect(quality.annotators.map((a) => [a.name, a.goldAccuracy, a.flagged])).toEqual([
      ['Ann', 0.6667, true],
      ['Ben', 1, false],
    ]);

    // a second run finds nothing to do
    const again = await applyRescore(s.project, wrong.id, s.pm.id);
    expect(again.ok && again.plan.changes).toEqual([]);
    expect(await scoresOf(ann.id)).toEqual([0, 1, 1]);
    expect(payload<GoldView>(await s.view(wrong.id)).gold?.rescore?.changes).toEqual([]);

    // work stays accepted and paid exactly as it was
    expect(
      await prisma.assignment.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, status: true, reviewStatus: true, answer: true, submittedAt: true },
      }),
    ).toEqual(acceptedBefore);
    expect(await payoutReport(s.org.id, { from: '2020-01-01', to: day })).toEqual(paidBefore);

    const activity = await run(
      activityLoader,
      makeRequest(`/projects/${s.project.id}/activity`, { cookie: s.pmCookie }),
      { projectId: s.project.id },
    );
    expect(
      payload<{ entries: Array<{ text: string }> }>(activity).entries.map((e) => e.text),
    ).toEqual([
      'rescored gold task #1: 2 scores changed for 2 annotators (1 newly flagged, 1 no longer flagged)',
      'changed the expected answer of gold task #1 from “positive” to “negative”: The text is clearly negative.',
    ]);
  });

  it('refuses an answer the schema does not allow, the same answer and a missing reason', async () => {
    const s = await goldProject();
    const [wrong] = s.gold;

    const unknown = await s.post(wrong.id, editForm('sarcastic'));
    expect(statusOf(unknown)).toBe(400);
    expect(payload<{ error: string }>(unknown).error).toMatch(/Unknown label: sarcastic/);
    expect(statusOf(await s.post(wrong.id, editForm('positive')))).toBe(409);
    expect(statusOf(await s.post(wrong.id, editForm('negative', '  ')))).toBe(400);
    // a task without an expected answer has nothing to edit
    expect(statusOf(await s.post(s.regular[0].id, editForm('negative')))).toBe(409);

    const task = await prisma.task.findUniqueOrThrow({ where: { id: wrong.id } });
    expect(task.goldAnswer).toEqual({ labels: ['positive'] });
    expect(await prisma.goldRevision.count()).toBe(0);
    expect(await prisma.activity.count()).toBe(0);
  });

  it('is for managers only; reviewers see how answers scored but not the expected answer', async () => {
    const s = await goldProject();
    const ann = await answersGold(s, 'Ann', ['positive']);
    const [wrong] = s.gold;
    const annCookie = await cookieFor(ann, s.org.id);
    const elsewhere = await createOrg('Elsewhere');
    const outsider = await cookieFor(await createMember(elsewhere.id, 'ADMIN'), elsewhere.id);

    const forms: Array<Record<string, string>> = [
      editForm('negative'),
      { intent: 'gold-rescore' },
      { intent: 'gold-retire', reason: 'Because' },
      { intent: 'gold-restore', reason: 'Because' },
      { intent: 'gold-copy' },
    ];
    for (const form of forms) {
      expect(statusOf(await s.post(wrong.id, form, s.reviewerCookie))).toBe(403);
      expect(statusOf(await s.post(wrong.id, form, annCookie))).toBe(403);
      expect(statusOf(await s.post(wrong.id, form, outsider))).toBe(404);
    }
    expect(await prisma.goldRevision.count()).toBe(0);

    const seen = payload<GoldView>(await s.view(wrong.id, s.reviewerCookie));
    expect(seen.gold).toBeNull();
    expect(seen.task.isGold).toBe(true);
    expect(seen.assignments.map((a) => a.goldScore)).toEqual([1]);
    expect(JSON.stringify(seen)).not.toContain('goldAnswer');
    expect(statusOf(await s.view(wrong.id, annCookie))).toBe(403);
  });

  it('scores a submission against the answer that stands when it is stored', async () => {
    const s = await goldProject();
    const [wrong] = s.gold;
    const ann = await createMember(s.org.id, 'ANNOTATOR');
    const claim = await claimNextTask(s.project, ann.id, new Date(Date.now() - 60_000));
    if (!claim.ok) throw new Error('nothing to claim');
    expect(claim.assignment.taskId).toBe(wrong.id);

    // an edit of the expected answer is under way while the answer is submitted
    let submitting: ReturnType<typeof submitAssignment> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: wrong.id },
        data: { goldAnswer: { labels: ['negative'] } },
      });
      submitting = submitAssignment(claim.assignment.id, ann.id, {
        answer: { labels: ['negative'] },
        activeSeconds: 5,
        reviewRequired: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    const stored = await submitting;
    expect(stored?.ok && stored.assignment.goldScore).toBe(1);
  });

  it('does not regrade past qualification attempts when a question changes', async () => {
    const s = await goldProject();
    const [question] = await createTasks(s.project.id, [{ text: 'Is this positive?' }]);
    await prisma.task.update({
      where: { id: question.id },
      data: { isQualification: true, goldAnswer: { labels: ['positive'] } },
    });
    const ann = await createMember(s.org.id, 'ANNOTATOR');
    const attempt = await prisma.qualificationAttempt.create({
      data: {
        projectId: s.project.id,
        userId: ann.id,
        scorePercent: 0,
        passed: false,
        answers: { [question.id]: { labels: ['negative'] } },
      },
    });

    expect(statusOf(await s.post(question.id, editForm('negative')))).toBe(302);

    expect(
      await prisma.qualificationAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).toEqual(attempt);
    const page = payload<GoldView & { gold: { isQualification: boolean } }>(
      await s.view(question.id),
    );
    expect(page.gold).toMatchObject({ isQualification: true, rescore: null });
    expect(statusOf(await s.post(question.id, { intent: 'gold-rescore' }))).toBe(409);
    expect(statusOf(await s.post(question.id, { intent: 'gold-retire', reason: 'x' }))).toBe(409);
  });

  it('keeps old and new expected answers as stored work for schema edits', async () => {
    const s = await goldProject();
    const [wrong] = s.gold;
    await prisma.task.update({
      where: { id: wrong.id },
      data: { goldAnswer: { labels: ['neutral'] } },
    });
    expect((await schemaUsage(s.project.id)).names.get('neutral')).toBe(1);

    await s.post(wrong.id, editForm('negative'));

    // "neutral" is no gold answer any more, but the history still shows it
    const usage = await schemaUsage(s.project.id);
    expect(usage.names.get('neutral')).toBe(1);
    expect(usage.names.get('negative')).toBe(2);
    // changed back and forth, every answer the task ever had still counts once
    await s.post(wrong.id, editForm('neutral', 'Back again.'));
    await s.post(wrong.id, editForm('negative', 'And once more.'));
    const later = await schemaUsage(s.project.id);
    expect(later.names.get('neutral')).toBe(1);
    expect(later.names.get('negative')).toBe(2);
    const refused = await run(
      settingsAction,
      makeRequest(`/projects/${s.project.id}/settings`, {
        cookie: s.pmCookie,
        form: {
          name: 'Sentiment',
          description: '',
          instructions: '',
          overlap: '1',
          timeLimitMinutes: '30',
          schema: JSON.stringify({ ...SENTIMENT, labels: ['positive', 'negative'] }),
        },
      }),
      { projectId: s.project.id },
    );
    expect(statusOf(refused)).toBe(400);
  });
});

describe('retiring a gold task', () => {
  beforeEach(resetDb);

  it('stops handing it out and stops counting its scores, and can be undone', async () => {
    const s = await goldProject();
    const ben = await answersGold(s, 'Ben', ['negative', 'positive', 'negative']);
    const [wrong] = s.gold;
    expect(await isAnnotatorFlagged(s.project.id, ben.id)).toBe(true);

    const retired = await s.post(wrong.id, {
      intent: 'gold-retire',
      reason: 'The answer is wrong.',
    });
    expect(statusOf(retired)).toBe(302);

    // the score is kept but counts for nobody
    expect(await scoresOf(ben.id)).toEqual([0, 1, 1]);
    expect(await isAnnotatorFlagged(s.project.id, ben.id)).toBe(false);
    const quality = await projectQuality(s.project);
    expect(quality.annotators[0]).toMatchObject({
      goldAttempts: 2,
      goldAccuracy: 1,
      flagged: false,
    });
    expect((await myStats(ben.id)).goldAccuracy).toBe(1);
    // a new annotator starts at the second gold task
    const cy = await createMember(s.org.id, 'ANNOTATOR');
    const claim = await claimNextTask(s.project, cy.id);
    expect(claim.ok && claim.assignment.taskId).toBe(s.gold[1].id);
    // and Ben's work on it is still accepted
    expect(
      await prisma.assignment.count({
        where: { userId: ben.id, status: 'SUBMITTED', reviewStatus: 'NOT_REQUIRED' },
      }),
    ).toBe(3);

    expect(statusOf(await s.post(wrong.id, { intent: 'gold-retire', reason: 'Again' }))).toBe(409);
    expect(statusOf(await s.post(wrong.id, { intent: 'gold-restore', reason: 'Fixed it.' }))).toBe(
      302,
    );
    expect(await isAnnotatorFlagged(s.project.id, ben.id)).toBe(true);
    const history = await prisma.goldRevision.findMany({ orderBy: { createdAt: 'asc' } });
    expect(history.map((h) => [h.change, h.reason, h.changedById])).toEqual([
      ['RETIRED', 'The answer is wrong.', s.pm.id],
      ['RESTORED', 'Fixed it.', s.pm.id],
    ]);
  });

  it('says before it happens whose accuracy moves, and takes one of two at once', async () => {
    const s = await goldProject();
    const ben = await answersGold(s, 'Ben', ['negative', 'positive', 'negative']);
    const [wrong] = s.gold;

    const page = payload<{
      gold: { retireImpact: { moved: unknown[]; noLongerFlagged: string[] } };
    }>(await s.view(wrong.id));
    expect(page.gold.retireImpact.moved).toHaveLength(1);
    expect(page.gold.retireImpact.noLongerFlagged).toEqual([ben.id]);

    const results = await Promise.all([
      setGoldRetired(s.project, wrong.id, s.pm.id, { retired: true, reason: 'one' }),
      setGoldRetired(s.project, wrong.id, s.pm.id, { retired: true, reason: 'two' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: 'already_done' });
    expect(await prisma.goldRevision.count()).toBe(1);
  });
});

describe('making gold tasks from completed tasks', () => {
  beforeEach(resetDb);

  async function completed() {
    const s = await goldProject(4);
    const ann = await createMember(s.org.id, 'ANNOTATOR', { name: 'Ann' });
    await addToProject(s.project.id, ann);
    // Ann works through the three gold tasks and the first two regular ones
    for (const label of ['negative', 'positive', 'negative', 'positive', 'negative']) {
      await submitWork(s.project, ann.id, { labels: [label] });
    }
    return { ...s, ann, done: s.regular.slice(0, 2), open: s.regular.slice(2) };
  }

  it('copies the task with its consensus as the expected answer and leaves the original alone', async () => {
    const s = await completed();
    const [source] = s.done;

    const result = await s.post(source.id, { intent: 'gold-copy' });
    const copy = await prisma.task.findFirstOrThrow({
      where: { goldSourceId: source.id },
      include: { goldRevisions: true },
    });
    expect(locationOf(result)).toBe(`/projects/${s.project.id}/tasks/${copy.id}`);
    expect(copy).toMatchObject({
      isGold: true,
      status: 'OPEN',
      goldAnswer: { labels: ['positive'] },
      batchId: source.batchId,
      externalId: source.externalId,
      data: source.data,
    });
    // somewhere among the open tasks, not after everything else
    expect(s.open.map((t) => t.position)).toContain(copy.position);
    expect(copy.goldRevisions).toMatchObject([
      { change: 'CREATED', answer: { labels: ['positive'] }, changedById: s.pm.id },
    ]);

    const original = await prisma.task.findUniqueOrThrow({ where: { id: source.id } });
    expect(original).toMatchObject({ isGold: false, status: 'COMPLETE', goldAnswer: null });
    const download = (await run(
      downloadLoader,
      makeRequest(`/projects/${s.project.id}/download?format=jsonl&scope=all`, {
        cookie: s.pmCookie,
      }),
      { projectId: s.project.id },
    )) as Response;
    const exported = (await download.text())
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l).task_id);
    expect(exported).toContain(source.id);
    expect(exported).not.toContain(copy.id);

    // once is enough
    const again = await s.post(source.id, { intent: 'gold-copy' });
    expect(statusOf(again)).toBe(409);
    expect(payload<{ error: string }>(again).error).toMatch(/already used as gold/);
  });

  it('never offers the copy to the annotator who worked on the original', async () => {
    const s = await completed();
    const [source] = s.done;
    const made = await promoteToGold(s.project, [source.id], s.pm.id, () => 0);
    const [copyId] = made.created;
    const copy = await prisma.task.findUniqueOrThrow({ where: { id: copyId } });
    expect(copy.position).toBe(s.open[0].position);

    // Ann would recognise it; she only gets the tasks that were open before
    const forAnn = [];
    for (;;) {
      const claim = await claimNextTask(s.project, s.ann.id);
      if (!claim.ok) break;
      forAnn.push(claim.assignment.taskId);
      await submitAssignment(claim.assignment.id, s.ann.id, {
        answer: { labels: ['positive'] },
        activeSeconds: 0,
        reviewRequired: false,
      });
    }
    expect(forAnn.sort()).toEqual(s.open.map((t) => t.id).sort());

    // someone who never saw the original gets the copy like any other task
    const cy = await createMember(s.org.id, 'ANNOTATOR');
    const seen = [];
    for (;;) {
      const claim = await claimNextTask(s.project, cy.id);
      if (!claim.ok) break;
      seen.push(claim.assignment.taskId);
      await submitAssignment(claim.assignment.id, cy.id, {
        answer: { labels: ['positive'] },
        activeSeconds: 0,
        reviewRequired: false,
      });
    }
    expect(seen).toContain(copyId);
    const scored = await prisma.assignment.findFirstOrThrow({
      where: { taskId: copyId, userId: cy.id },
    });
    expect(scored).toMatchObject({ goldScore: 1, reviewStatus: 'NOT_REQUIRED' });
  });

  it('takes several at once from the batch page and says what it skipped', async () => {
    const s = await completed();
    const batchId = s.done[0].batchId;
    const form = {
      intent: 'gold-copy',
      taskId: [s.done[0].id, s.done[1].id, s.open[0].id, s.gold[0].id],
    };
    const post = (cookie: string) =>
      run(
        batchAction,
        makeRequest(`/projects/${s.project.id}/batches/${batchId}`, { cookie, form }),
        { projectId: s.project.id, batchId },
      );

    expect(statusOf(await post(s.reviewerCookie))).toBe(403);
    expect(statusOf(await post(s.pmCookie))).toBe(302);

    const copies = await prisma.task.findMany({ where: { goldSourceId: { not: null } } });
    expect(copies.map((c) => c.goldSourceId).sort()).toEqual(s.done.map((t) => t.id).sort());
    const batches = await listBatches(s.project.id);
    // gold never completes, so it is counted apart from the batch's progress
    expect(batches[0]).toMatchObject({ total: 4, complete: 2, gold: 5 });
  });

  it('validates the consensus against the schema as it is now', async () => {
    const s = await completed();
    const [source] = s.done;
    // the project's labels changed after the task was completed
    const narrowed = { ...SENTIMENT, labels: ['negative', 'neutral'] };
    const project = await prisma.project.update({
      where: { id: s.project.id },
      data: { schema: narrowed },
    });

    const outcome = await promoteToGold(project, [source.id, s.open[0].id], s.pm.id);

    expect(outcome.created).toEqual([]);
    expect(outcome.skipped).toEqual([
      {
        taskId: source.id,
        why: 'its consensus is not a valid answer any more: Unknown label: positive',
      },
      { taskId: s.open[0].id, why: 'not complete, or without a consensus' },
    ]);
    expect(await prisma.task.count({ where: { goldSourceId: { not: null } } })).toBe(0);
  });
});

describe('what an annotator can tell about gold', () => {
  beforeEach(resetDb);

  it('gets the same from the work page for a gold task as for any other', async () => {
    const s = await goldProject();
    const ann = await createMember(s.org.id, 'ANNOTATOR');
    await addToProject(s.project.id, ann);
    const cookie = await cookieFor(ann, s.org.id);
    const open = async () => {
      const claim = await claimNextTask(s.project, ann.id);
      if (!claim.ok) throw new Error('nothing to claim');
      const page = await run(workLoader, makeRequest(`/work/${claim.assignment.id}`, { cookie }), {
        assignmentId: claim.assignment.id,
      });
      return { claim: claim.assignment, page: payload<Record<string, object>>(page) };
    };
    const shape = (value: unknown): unknown =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, inner]) => [key, shape(inner)]),
          )
        : typeof value;

    const gold = await open();
    expect(gold.claim.taskId).toBe(s.gold[0].id);
    await submitAssignment(gold.claim.id, ann.id, {
      answer: { labels: ['negative'] },
      activeSeconds: 0,
      reviewRequired: false,
    });
    for (const task of s.gold.slice(1)) await prisma.task.delete({ where: { id: task.id } });
    const regular = await open();
    expect(regular.claim.taskId).toBe(s.regular[0].id);

    // the same fields, and nothing that names the task, its gold answer or its kind
    expect(shape(gold.page)).toEqual(shape(regular.page));
    const sent = JSON.stringify(gold.page);
    expect(sent).not.toContain(s.gold[0].id);
    expect(sent).not.toMatch(/gold/i);
    expect(sent).not.toContain('"positive"]');
    expect(Object.keys(gold.page.task).sort()).toEqual(['batch', 'data', 'externalId']);
  });

  it('shows the score and the expected answer only after submitting, and only if the project does', async () => {
    const s = await goldProject();
    const ann = await answersGold(s, 'Ann', ['negative']);
    const cookie = await cookieFor(ann, s.org.id);
    const [submission] = await prisma.assignment.findMany({ where: { userId: ann.id } });
    const list = () => run(myWorkLoader, makeRequest('/my-work', { cookie }));
    const detail = (who = cookie) =>
      run(reviseLoader, makeRequest(`/my-work/${submission.id}`, { cookie: who }), {
        assignmentId: submission.id,
      });

    expect(
      payload<{ items: Array<{ goldScore: number | null }> }>(await list()).items[0].goldScore,
    ).toBe(0);
    expect(payload<Record<string, unknown>>(await detail())).toMatchObject({
      mode: 'gold',
      corrected: { labels: ['positive'] },
      goldCheck: { score: 0, expected: 'positive' },
    });
    // nobody else's
    const other = await createMember(s.org.id, 'ANNOTATOR');
    expect(statusOf(await detail(await cookieFor(other, s.org.id)))).toBe(404);

    await prisma.project.update({ where: { id: s.project.id }, data: { goldFeedback: false } });
    const hidden = await list();
    expect(
      payload<{ items: Array<{ goldScore: number | null }> }>(hidden).items[0].goldScore,
    ).toBeNull();
    expect(JSON.stringify(payload(hidden))).not.toMatch(/gold(Answer|Retired)|isGold/);
    expect(locationOf(await detail())).toBe('/my-work');
  });

  it('lists the gold tasks people miss most on the quality page', async () => {
    const s = await goldProject();
    await answersGold(s, 'Ann', ['negative', 'positive', 'negative']);
    await answersGold(s, 'Ben', ['negative', 'positive', 'positive']);

    const quality = await run(
      qualityLoader,
      makeRequest(`/projects/${s.project.id}/quality`, { cookie: s.reviewerCookie }),
      { projectId: s.project.id },
    );
    expect(
      payload<{ lowestGold: Array<Record<string, unknown>> }>(quality).lowestGold,
    ).toMatchObject([
      { taskId: s.gold[0].id, average: 0, answers: 2 },
      { taskId: s.gold[2].id, average: 0.5, answers: 2 },
      { taskId: s.gold[1].id, average: 1, answers: 2 },
    ]);
  });
});
