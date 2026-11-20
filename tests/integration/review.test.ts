import { beforeEach, describe, expect, it } from 'vitest';

import { ALWAYS_REVIEW_FIRST } from '~/domain/review-sampling';
import { claimNextTask, submitAssignment } from '~/models/queue.server';
import { action as reviseAction } from '~/routes/my-work-revise';
import { loader as myWorkLoader } from '~/routes/my-work';
import { action as reviewAction, loader as reviewLoader } from '~/routes/review';
import { loader as queueLoader } from '~/routes/project-review';
import { loader as taskLoader } from '~/routes/task-detail';
import { action as workAction } from '~/routes/work';

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
  const project = await createTestProject(org.id);
  await createTasks(project.id, [{ text: 'one' }, { text: 'two' }]);
  const ann = await createMember(org.id, 'ANNOTATOR');
  const reviewer = await createMember(org.id, 'REVIEWER');
  await addToProject(project.id, ann, reviewer);
  const submission = await submitWork(project, ann.id, { labels: ['positive'] });
  return {
    org,
    project,
    ann,
    reviewer,
    submission,
    reviewerCookie: await cookieFor(reviewer, org.id),
    annCookie: await cookieFor(ann, org.id),
  };
}

describe('review', () => {
  beforeEach(resetDb);

  it('queues submissions that need review', async () => {
    const { project, reviewerCookie, submission } = await setup();
    expect(submission.reviewStatus).toBe('PENDING');

    const result = await run(
      queueLoader,
      makeRequest(`/projects/${project.id}/review`, { cookie: reviewerCookie }),
      {
        projectId: project.id,
      },
    );
    expect(payload<{ pending: Array<{ id: string }> }>(result).pending.map((p) => p.id)).toEqual([
      submission.id,
    ]);
  });

  it('skips review when the project does not require it', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { reviewRequired: false });
    await createTasks(project.id, [{ text: 'x' }]);
    const ann = await createMember(org.id, 'ANNOTATOR');
    const submission = await submitWork(project, ann.id, { labels: ['negative'] });
    expect(submission.reviewStatus).toBe('NOT_REQUIRED');
  });

  it('approves with a quality score', async () => {
    const { reviewerCookie, submission, project } = await setup();

    const result = await run(
      reviewAction,
      makeRequest(`/review/${submission.id}`, {
        cookie: reviewerCookie,
        form: { intent: 'approve', qaScore: '4', feedback: '' },
      }),
      { assignmentId: submission.id },
    );

    expect(locationOf(result)).toBe(`/projects/${project.id}/review?done=1`);
    const updated = await prisma.assignment.findUniqueOrThrow({
      where: { id: submission.id },
      include: { reviews: true },
    });
    expect(updated.reviewStatus).toBe('APPROVED');
    expect(updated.reviews[0]).toMatchObject({ decision: 'APPROVE', qaScore: 4 });
  });

  it('requires feedback when sending work back', async () => {
    const { reviewerCookie, submission } = await setup();
    const result = await run(
      reviewAction,
      makeRequest(`/review/${submission.id}`, {
        cookie: reviewerCookie,
        form: { intent: 'send_back', feedback: '' },
      }),
      { assignmentId: submission.id },
    );
    expect(statusOf(result)).toBe(400);
  });

  it('lets the annotator revise and resubmit sent-back work', async () => {
    const { reviewerCookie, annCookie, submission, ann, org } = await setup();
    await run(
      reviewAction,
      makeRequest(`/review/${submission.id}`, {
        cookie: reviewerCookie,
        form: { intent: 'send_back', feedback: 'Sarcasm: this one is negative.', qaScore: '2' },
      }),
      { assignmentId: submission.id },
    );

    const mine = await run(
      myWorkLoader,
      makeRequest('/my-work?filter=returned', { cookie: annCookie }),
    );
    expect(payload<{ items: Array<{ feedback: string }> }>(mine).items[0].feedback).toMatch(
      /Sarcasm/,
    );

    const result = await run(
      reviseAction,
      makeRequest(`/my-work/${submission.id}`, {
        cookie: annCookie,
        form: { answer: '{"labels":["negative"]}' },
      }),
      { assignmentId: submission.id },
    );
    expect(locationOf(result)).toBe('/my-work?filter=returned');
    const updated = await prisma.assignment.findUniqueOrThrow({ where: { id: submission.id } });
    expect(updated).toMatchObject({ reviewStatus: 'PENDING', answer: { labels: ['negative'] } });

    const other = await createMember(org.id, 'ANNOTATOR');
    const stolen = await run(
      reviseAction,
      makeRequest(`/my-work/${submission.id}`, {
        cookie: await cookieFor(other, org.id),
        form: { answer: '{"labels":["positive"]}' },
      }),
      { assignmentId: submission.id },
    );
    expect(statusOf(stolen)).toBe(404);
    expect(ann.id).toBeTruthy();
  });

  it('stores a reviewer correction when fixing', async () => {
    const { reviewerCookie, submission } = await setup();
    await run(
      reviewAction,
      makeRequest(`/review/${submission.id}`, {
        cookie: reviewerCookie,
        form: { intent: 'fix', corrected: '{"labels":["negative"]}', qaScore: '3' },
      }),
      { assignmentId: submission.id },
    );
    const review = await prisma.review.findFirstOrThrow();
    expect(review).toMatchObject({ decision: 'FIX', correctedAnswer: { labels: ['negative'] } });
    const original = await prisma.assignment.findUniqueOrThrow({ where: { id: submission.id } });
    expect(original).toMatchObject({ reviewStatus: 'FIXED', answer: { labels: ['positive'] } });
  });

  it('rejects an invalid correction', async () => {
    const { reviewerCookie, submission } = await setup();
    const result = await run(
      reviewAction,
      makeRequest(`/review/${submission.id}`, {
        cookie: reviewerCookie,
        form: { intent: 'fix', corrected: '{"labels":["unknown"]}' },
      }),
      { assignmentId: submission.id },
    );
    expect(statusOf(result)).toBe(400);
  });

  it('does not let annotators approve their own work by posting the form', async () => {
    const { annCookie, submission } = await setup();
    const result = await run(
      reviewAction,
      makeRequest(`/review/${submission.id}`, {
        cookie: annCookie,
        form: { intent: 'approve', qaScore: '5' },
      }),
      { assignmentId: submission.id },
    );
    expect(statusOf(result)).toBe(403);
    const stored = await prisma.assignment.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.reviewStatus).toBe('PENDING');
    expect(await prisma.review.count()).toBe(0);
  });

  it('does not let reviewers from another organisation review', async () => {
    const { submission } = await setup();
    const otherOrg = await createOrg('Elsewhere');
    const outsider = await createMember(otherOrg.id, 'REVIEWER');
    const result = await run(
      reviewAction,
      makeRequest(`/review/${submission.id}`, {
        cookie: await cookieFor(outsider, otherOrg.id),
        form: { intent: 'approve' },
      }),
      { assignmentId: submission.id },
    );
    expect(statusOf(result)).toBe(404);
  });

  it('does not let an admin review a submission they made', async () => {
    const { org, project } = await setup();
    const admin = await createMember(org.id, 'ADMIN');
    const own = await submitWork(project, admin.id, { labels: ['negative'] });
    const result = await run(
      reviewAction,
      makeRequest(`/review/${own.id}`, {
        cookie: await cookieFor(admin, org.id),
        form: { intent: 'approve' },
      }),
      { assignmentId: own.id },
    );
    expect(statusOf(result)).toBe(403);
  });

  it('does not show the review page to annotators', async () => {
    const { annCookie, submission } = await setup();
    const result = await run(
      reviewLoader,
      makeRequest(`/review/${submission.id}`, { cookie: annCookie }),
      {
        assignmentId: submission.id,
      },
    );
    expect(statusOf(result)).toBe(403);
  });

  it('refuses a second review of the same submission', async () => {
    const { reviewerCookie, submission } = await setup();
    const path = `/review/${submission.id}`;
    await run(
      reviewAction,
      makeRequest(path, { cookie: reviewerCookie, form: { intent: 'approve' } }),
      {
        assignmentId: submission.id,
      },
    );
    const again = await run(
      reviewAction,
      makeRequest(path, { cookie: reviewerCookie, form: { intent: 'approve' } }),
      {
        assignmentId: submission.id,
      },
    );
    expect(statusOf(again)).toBe(409);
  });
});

describe('reviewer stats', () => {
  beforeEach(resetDb);

  it('counts the decisions of the last week', async () => {
    const { reviewer, reviewerCookie, submission } = await setup();
    await run(
      reviewAction,
      makeRequest(`/review/${submission.id}`, {
        cookie: reviewerCookie,
        form: { intent: 'send_back', qaScore: '2', feedback: 'Check the label' },
      }),
      { assignmentId: submission.id },
    );
    const { reviewerStats } = await import('~/models/annotator-stats.server');
    expect(await reviewerStats(reviewer.id)).toEqual({
      reviews: 1,
      sentBack: 1,
      fixed: 0,
      avgScore: 2,
    });
  });
});

describe('task completion', () => {
  beforeEach(resetDb);

  it('completes a task once enough submissions are approved', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 2 });
    const [task] = await createTasks(project.id, [{ text: 'x' }]);
    const a = await createMember(org.id, 'ANNOTATOR');
    const b = await createMember(org.id, 'ANNOTATOR');
    const reviewer = await createMember(org.id, 'REVIEWER');
    await addToProject(project.id, reviewer);
    const cookie = await cookieFor(reviewer, org.id);
    const first = await submitWork(project, a.id, { labels: ['positive'] });
    const second = await submitWork(project, b.id, { labels: ['positive'] });

    const approve = (id: string) =>
      run(reviewAction, makeRequest(`/review/${id}`, { cookie, form: { intent: 'approve' } }), {
        assignmentId: id,
      });

    await approve(first.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('OPEN');
    await approve(second.id);
    const done = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(done.status).toBe('COMPLETE');
    expect(done.completedAt).not.toBeNull();
  });

  it('completes immediately when review is not required', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { reviewRequired: false });
    const [task] = await createTasks(project.id, [{ text: 'x' }]);
    const a = await createMember(org.id, 'ANNOTATOR');
    await submitWork(project, a.id, { labels: ['negative'] });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      'COMPLETE',
    );
  });
});

describe('consensus on completion', () => {
  beforeEach(resetDb);

  it('stores the merged answer and agreement', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 3, reviewRequired: false });
    const [task] = await createTasks(project.id, [{ text: 'x' }]);
    for (const label of ['positive', 'positive', 'negative']) {
      const user = await createMember(org.id, 'ANNOTATOR');
      await submitWork(project, user.id, { labels: [label] });
    }
    const done = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(done).toMatchObject({ status: 'COMPLETE', consensus: { labels: ['positive'] } });
    expect(done.agreement).toBeCloseTo(0.6667);
  });
});

/** Gives an annotator a history of submissions that went to review in the project. */
async function withHistory(projectId: string, userId: string, count = ALWAYS_REVIEW_FIRST) {
  const tasks = await createTasks(
    projectId,
    Array.from({ length: count }, (_, i) => ({ text: `earlier ${i}` })),
  );
  const at = new Date(Date.now() - 24 * 60 * 60_000);
  await prisma.assignment.createMany({
    data: tasks.map((task) => ({
      projectId,
      taskId: task.id,
      userId,
      status: 'SUBMITTED' as const,
      claimedAt: at,
      expiresAt: at,
      submittedAt: at,
      answer: { labels: ['positive'] },
      reviewStatus: 'APPROVED' as const,
      reviewedAt: at,
    })),
  });
  await prisma.task.updateMany({
    where: { id: { in: tasks.map((t) => t.id) } },
    data: { status: 'COMPLETE' },
  });
}

const drawn = () => 0.1;
const notDrawn = () => 0.9;
const taskStatus = async (id: string) =>
  (await prisma.task.findUniqueOrThrow({ where: { id } })).status;

describe('review sampling', () => {
  beforeEach(resetDb);

  async function sampledProject(overrides: { overlap?: number; reviewSamplePercent?: number }) {
    const org = await createOrg();
    const project = await createTestProject(org.id, { reviewSamplePercent: 50, ...overrides });
    const ann = await createMember(org.id, 'ANNOTATOR');
    const reviewer = await createMember(org.id, 'REVIEWER');
    await addToProject(project.id, ann, reviewer);
    return { org, project, ann, reviewer, reviewerCookie: await cookieFor(reviewer, org.id) };
  }

  it('sends the drawn share to review and accepts the rest at once', async () => {
    const { project, ann } = await sampledProject({});
    const [first, second] = await createTasks(project.id, [{ text: 'one' }, { text: 'two' }]);
    await withHistory(project.id, ann.id);

    const sampled = await submitWork(project, ann.id, { labels: ['positive'] }, { random: drawn });
    expect(sampled).toMatchObject({ reviewStatus: 'PENDING', reviewSample: 'DRAWN' });
    expect(await taskStatus(first.id)).toBe('OPEN');

    const passed = await submitWork(
      project,
      ann.id,
      { labels: ['negative'] },
      { random: notDrawn },
    );
    expect(passed).toMatchObject({ reviewStatus: 'NOT_REQUIRED', reviewSample: 'NOT_DRAWN' });
    const done = await prisma.task.findUniqueOrThrow({ where: { id: second.id } });
    expect(done).toMatchObject({ status: 'COMPLETE', consensus: { labels: ['negative'] } });
  });

  it('reviews the first ten submissions of an annotator whatever the draw says', async () => {
    const { project, ann } = await sampledProject({ reviewSamplePercent: 10 });
    await createTasks(
      project.id,
      Array.from({ length: ALWAYS_REVIEW_FIRST + 1 }, (_, i) => ({ text: `task ${i}` })),
    );

    const outcomes = [];
    for (let i = 0; i <= ALWAYS_REVIEW_FIRST; i++) {
      const done = await submitWork(
        project,
        ann.id,
        { labels: ['positive'] },
        { random: notDrawn },
      );
      outcomes.push(done.reviewSample);
    }
    expect(outcomes.slice(0, ALWAYS_REVIEW_FIRST)).toEqual(
      Array(ALWAYS_REVIEW_FIRST).fill('NEW_ANNOTATOR'),
    );
    expect(outcomes[ALWAYS_REVIEW_FIRST]).toBe('NOT_DRAWN');
    expect(
      await prisma.assignment.count({ where: { userId: ann.id, reviewStatus: 'PENDING' } }),
    ).toBe(ALWAYS_REVIEW_FIRST);
  });

  it('reviews everything from an annotator flagged for gold accuracy', async () => {
    const { project, ann } = await sampledProject({ reviewSamplePercent: 10 });
    await withHistory(project.id, ann.id);
    const gold = await createTasks(project.id, [{ text: 'g1' }, { text: 'g2' }, { text: 'g3' }]);
    const at = new Date(Date.now() - 60 * 60_000);
    await prisma.task.updateMany({
      where: { id: { in: gold.map((t) => t.id) } },
      data: { isGold: true, goldAnswer: { labels: ['positive'] } },
    });
    await prisma.assignment.createMany({
      data: gold.map((task) => ({
        projectId: project.id,
        taskId: task.id,
        userId: ann.id,
        status: 'SUBMITTED' as const,
        claimedAt: at,
        expiresAt: at,
        submittedAt: at,
        answer: { labels: ['negative'] },
        reviewStatus: 'NOT_REQUIRED' as const,
        goldScore: 0,
      })),
    });
    await createTasks(project.id, [{ text: 'regular' }]);

    const work = await submitWork(project, ann.id, { labels: ['positive'] }, { random: notDrawn });
    expect(work).toMatchObject({ reviewStatus: 'PENDING', reviewSample: 'FLAGGED' });
  });

  it('completes a task that unsampled and reviewed work fill together', async () => {
    const { org, project, ann, reviewerCookie } = await sampledProject({ overlap: 2 });
    const [task] = await createTasks(project.id, [{ text: 'shared' }]);
    const other = await createMember(org.id, 'ANNOTATOR');
    await withHistory(project.id, ann.id);
    await withHistory(project.id, other.id);

    await submitWork(project, ann.id, { labels: ['positive'] }, { random: notDrawn });
    expect(await taskStatus(task.id)).toBe('OPEN');
    const sampled = await submitWork(
      project,
      other.id,
      { labels: ['positive'] },
      { random: drawn },
    );
    expect(await taskStatus(task.id)).toBe('OPEN');

    await run(
      reviewAction,
      makeRequest(`/review/${sampled.id}`, { cookie: reviewerCookie, form: { intent: 'approve' } }),
      { assignmentId: sampled.id },
    );
    expect(await taskStatus(task.id)).toBe('COMPLETE');
  });

  it('keeps the stored outcome when pages are loaded and when work comes back', async () => {
    const { project, ann, reviewerCookie } = await sampledProject({ reviewSamplePercent: 0 });
    await createTasks(project.id, [{ text: 'one' }]);
    const fresh = await submitWork(project, ann.id, { labels: ['positive'] });
    expect(fresh).toMatchObject({ reviewStatus: 'PENDING', reviewSample: 'NEW_ANNOTATOR' });
    await withHistory(project.id, ann.id);
    const [later] = await createTasks(project.id, [{ text: 'two' }]);
    const passed = await submitWork(project, ann.id, { labels: ['positive'] });
    expect(passed.reviewSample).toBe('NOT_DRAWN');

    // the queue, the review page and the task page only read what was stored
    const pages: Array<[Parameters<typeof run>[0], string, Record<string, string>]> = [
      [queueLoader, `/projects/${project.id}/review`, { projectId: project.id }],
      [reviewLoader, `/review/${passed.id}`, { assignmentId: passed.id }],
      [
        taskLoader,
        `/projects/${project.id}/tasks/${later.id}`,
        { projectId: project.id, taskId: later.id },
      ],
    ];
    for (const [loader, path, params] of pages) {
      expect(
        statusOf(await run(loader, makeRequest(path, { cookie: reviewerCookie }), params)),
      ).toBe(200);
    }
    expect(await prisma.assignment.findUniqueOrThrow({ where: { id: passed.id } })).toMatchObject({
      reviewStatus: 'NOT_REQUIRED',
      reviewSample: 'NOT_DRAWN',
    });

    // sent-back work returns to the queue without another draw
    await run(
      reviewAction,
      makeRequest(`/review/${fresh.id}`, {
        cookie: reviewerCookie,
        form: { intent: 'send_back', feedback: 'Look again' },
      }),
      { assignmentId: fresh.id },
    );
    const { resubmitAssignment } = await import('~/models/queue.server');
    expect(await resubmitAssignment(fresh.id, ann.id, { labels: ['negative'] })).toEqual({
      ok: true,
    });
    expect(await prisma.assignment.findUniqueOrThrow({ where: { id: fresh.id } })).toMatchObject({
      reviewStatus: 'PENDING',
      reviewSample: 'NEW_ANNOTATOR',
    });
  });

  it('draws once when the same answer is posted twice at the same moment', async () => {
    const { project, ann } = await sampledProject({});
    await createTasks(project.id, [{ text: 'one' }]);
    await withHistory(project.id, ann.id);
    const claimedAt = new Date(Date.now() - 60_000);
    const claim = await claimNextTask(project, ann.id, claimedAt);
    if (!claim.ok) throw new Error('nothing to claim');
    const input = {
      answer: { labels: ['positive'] },
      activeSeconds: 10,
      reviewRequired: true,
      reviewSamplePercent: 50,
    };

    const results = await Promise.all([
      submitAssignment(claim.assignment.id, ann.id, input, new Date(), drawn),
      submitAssignment(claim.assignment.id, ann.id, input, new Date(), notDrawn),
    ]);

    const stored = results.filter((r) => r.ok);
    expect(stored).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: 'not_active' });
    const saved = await prisma.assignment.findUniqueOrThrow({ where: { id: claim.assignment.id } });
    expect(stored[0].ok && stored[0].assignment.reviewSample).toBe(saved.reviewSample);
    expect(saved.reviewStatus).toBe(saved.reviewSample === 'DRAWN' ? 'PENDING' : 'NOT_REQUIRED');
  });

  it('applies the project share to work submitted through the form', async () => {
    const { org, project, ann } = await sampledProject({ reviewSamplePercent: 0 });
    const [task] = await createTasks(project.id, [{ text: 'one' }]);
    await withHistory(project.id, ann.id);
    const claim = await claimNextTask(project, ann.id);
    if (!claim.ok) throw new Error('nothing to claim');

    await run(
      workAction,
      makeRequest(`/work/${claim.assignment.id}`, {
        cookie: await cookieFor(ann, org.id),
        form: { intent: 'submit', answer: '{"labels":["positive"]}', activeSeconds: '0' },
      }),
      { assignmentId: claim.assignment.id },
    );

    const saved = await prisma.assignment.findUniqueOrThrow({ where: { id: claim.assignment.id } });
    expect(saved).toMatchObject({ reviewStatus: 'NOT_REQUIRED', reviewSample: 'NOT_DRAWN' });
    expect(await taskStatus(task.id)).toBe('COMPLETE');
  });
});
