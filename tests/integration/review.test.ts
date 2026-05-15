import { beforeEach, describe, expect, it } from 'vitest';

import { action as reviseAction } from '~/routes/my-work-revise';
import { loader as myWorkLoader } from '~/routes/my-work';
import { action as reviewAction, loader as reviewLoader } from '~/routes/review';
import { loader as queueLoader } from '~/routes/project-review';

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
