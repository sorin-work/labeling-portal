import { beforeEach, describe, expect, it } from 'vitest';

import { reviewerStats } from '~/models/annotator-stats.server';
import { openDispute, resolveDispute, withdrawDispute } from '~/models/disputes.server';
import { payoutReport } from '~/models/payouts.server';
import { schemaUsage } from '~/models/projects.server';
import { projectQuality } from '~/models/quality.server';
import { resubmitAssignment, saveRevisionDraft } from '~/models/queue.server';
import { action as draftAction } from '~/routes/my-work-draft';
import { action as reviseAction, loader as reviseLoader } from '~/routes/my-work-revise';
import { loader as myWorkLoader } from '~/routes/my-work';
import { action as disputeAction, loader as disputeLoader } from '~/routes/project-dispute';
import { loader as disputesLoader } from '~/routes/project-disputes';
import { loader as downloadLoader } from '~/routes/project-download';
import { loader as layoutLoader } from '~/routes/project-layout';
import { action as reviewAction } from '~/routes/review';
import { loader as taskLoader } from '~/routes/task-detail';

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

/**
 * One submission by Ann, a reviewer who decides on it, and two people who may
 * settle a dispute: a second reviewer and a project manager.
 */
async function setup() {
  const org = await createOrg();
  const project = await createTestProject(org.id);
  const [task] = await createTasks(project.id, [{ text: 'one' }, { text: 'two' }]);
  const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
  const reviewer = await createMember(org.id, 'REVIEWER', { name: 'Rafael' });
  const second = await createMember(org.id, 'REVIEWER', { name: 'Sam' });
  const pm = await createMember(org.id, 'PROJECT_MANAGER', { name: 'Priya' });
  await addToProject(project.id, ann, reviewer, second);
  const submission = await submitWork(project, ann.id, { labels: ['positive'] });
  const cookies = {
    ann: await cookieFor(ann, org.id),
    reviewer: await cookieFor(reviewer, org.id),
    second: await cookieFor(second, org.id),
    pm: await cookieFor(pm, org.id),
  };
  return { org, project, task, ann, reviewer, second, pm, submission, cookies };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const review = (s: Setup, form: Record<string, string>) =>
  run(
    reviewAction,
    makeRequest(`/review/${s.submission.id}`, { cookie: s.cookies.reviewer, form }),
    { assignmentId: s.submission.id },
  );
const sendBack = (s: Setup) =>
  review(s, { intent: 'send_back', qaScore: '2', feedback: 'This one is negative.' });
const fix = (s: Setup) =>
  review(s, { intent: 'fix', qaScore: '2', corrected: '{"labels":["negative"]}' });

const postMyWork = (id: string, cookie: string, form: Record<string, string>) =>
  run(reviseAction, makeRequest(`/my-work/${id}`, { cookie, form }), { assignmentId: id });
const dispute = (s: Setup, reason = 'The review is positive, read the last sentence.') =>
  postMyWork(s.submission.id, s.cookies.ann, { intent: 'dispute', reason });

const settle = (s: Setup, disputeId: string, cookie: string, form: Record<string, string>) =>
  run(
    disputeAction,
    makeRequest(`/projects/${s.project.id}/disputes/${disputeId}`, { cookie, form }),
    { projectId: s.project.id, disputeId },
  );

const stored = (s: Setup) =>
  prisma.assignment.findUniqueOrThrow({
    where: { id: s.submission.id },
    include: { reviews: true, disputes: true },
  });

describe('opening a dispute', () => {
  beforeEach(resetDb);

  it('lets the annotator dispute sent-back work, once', async () => {
    const s = await setup();
    await sendBack(s);

    expect(statusOf(await dispute(s, '   '))).toBe(400);
    expect(locationOf(await dispute(s))).toBe(`/my-work/${s.submission.id}`);
    const { reviews, disputes } = await stored(s);
    expect(disputes).toHaveLength(1);
    expect(disputes[0]).toMatchObject({
      status: 'OPEN',
      reviewId: reviews[0].id,
      openedById: s.ann.id,
      reason: 'The review is positive, read the last sentence.',
      answer: { labels: ['positive'] },
    });

    const again = await dispute(s, 'Once more');
    expect(statusOf(again)).toBe(409);
    expect(payload<{ error: string }>(again).error).toMatch(/already been disputed/);
    expect(await prisma.dispute.count()).toBe(1);
  });

  it('is only for the annotator whose work it is, and only for sent-back or fixed work', async () => {
    const s = await setup();
    const other = await createMember(s.org.id, 'ANNOTATOR');
    await addToProject(s.project.id, other);

    // still waiting for review: nothing to dispute yet
    expect(statusOf(await dispute(s))).toBe(409);
    await sendBack(s);

    const form = { intent: 'dispute', reason: 'Not mine, but I disagree' };
    for (const cookie of [await cookieFor(other, s.org.id), s.cookies.reviewer, s.cookies.pm]) {
      expect(statusOf(await postMyWork(s.submission.id, cookie, form))).toBe(404);
    }
    expect(await openDispute(s.submission.id, other.id, 'Not mine')).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await prisma.dispute.count()).toBe(0);
  });

  it('closes after the window set on the project, and not at all at zero days', async () => {
    const s = await setup();
    await sendBack(s);
    const { reviews } = await stored(s);
    const decidedAt = reviews[0].createdAt;
    const days = (n: number) => new Date(decidedAt.getTime() + n * 24 * 60 * 60_000);

    await prisma.project.update({ where: { id: s.project.id }, data: { disputeWindowDays: 3 } });
    expect(await openDispute(s.submission.id, s.ann.id, 'Late', days(4))).toEqual({
      ok: false,
      error: 'too_late',
    });
    await prisma.project.update({ where: { id: s.project.id }, data: { disputeWindowDays: 0 } });
    const off = await dispute(s);
    expect(statusOf(off)).toBe(409);
    expect(payload<{ error: string }>(off).error).toMatch(/does not take disputes/);

    await prisma.project.update({ where: { id: s.project.id }, data: { disputeWindowDays: 3 } });
    expect(await openDispute(s.submission.id, s.ann.id, 'In time', days(3))).toMatchObject({
      ok: true,
    });
  });

  it('is revise or dispute, never both', async () => {
    const s = await setup();
    await sendBack(s);
    await dispute(s);

    const revised = await postMyWork(s.submission.id, s.cookies.ann, {
      answer: '{"labels":["negative"]}',
    });
    expect(statusOf(revised)).toBe(409);
    expect(payload<{ error: string }>(revised).error).toMatch(/disputed this decision/);
    expect(await stored(s)).toMatchObject({
      reviewStatus: 'SENT_BACK',
      answer: { labels: ['positive'] },
    });
    const page = await run(
      reviseLoader,
      makeRequest(`/my-work/${s.submission.id}`, { cookie: s.cookies.ann }),
      { assignmentId: s.submission.id },
    );
    expect(payload<{ dispute: { status: string }; disputeUntil: unknown }>(page)).toMatchObject({
      dispute: { status: 'OPEN' },
      disputeUntil: null,
    });
  });

  it('lets only one of a dispute and a revision through when both arrive at once', async () => {
    const s = await setup();
    await sendBack(s);

    const [opened, revised] = await Promise.all([
      openDispute(s.submission.id, s.ann.id, 'I was right'),
      resubmitAssignment(s.submission.id, s.ann.id, { labels: ['negative'] }),
    ]);

    expect([opened.ok, revised.ok].filter(Boolean)).toHaveLength(1);
    const after = await stored(s);
    if (opened.ok) {
      expect(revised).toEqual({ ok: false, error: 'disputed' });
      expect(after).toMatchObject({ reviewStatus: 'SENT_BACK', answer: { labels: ['positive'] } });
      expect(after.disputes).toHaveLength(1);
    } else {
      expect(opened).toEqual({ ok: false, error: 'not_disputable' });
      expect(after).toMatchObject({ reviewStatus: 'PENDING', answer: { labels: ['negative'] } });
      expect(after.disputes).toHaveLength(0);
    }
  });

  it('makes a dispute wait for a revision that is under way, and the other way round', async () => {
    const s = await setup();
    await sendBack(s);
    const { reviews } = await stored(s);
    const id = s.submission.id;
    const pause = () => new Promise((resolve) => setTimeout(resolve, 250));

    // a revision holds the submission: the dispute waits, then finds the work revised
    let opening: ReturnType<typeof openDispute> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Assignment" WHERE id = ${id} FOR UPDATE`;
      opening = openDispute(id, s.ann.id, 'I was right');
      await pause();
      await tx.assignment.update({ where: { id }, data: { reviewStatus: 'PENDING' } });
    });
    expect(await opening).toEqual({ ok: false, error: 'not_disputable' });
    expect(await prisma.dispute.count()).toBe(0);

    // a dispute holds the submission: the revision waits, then finds the dispute
    await prisma.assignment.update({ where: { id }, data: { reviewStatus: 'SENT_BACK' } });
    let revising: ReturnType<typeof resubmitAssignment> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Assignment" WHERE id = ${id} FOR UPDATE`;
      revising = resubmitAssignment(id, s.ann.id, { labels: ['negative'] });
      await pause();
      await tx.dispute.create({
        data: {
          assignmentId: id,
          reviewId: reviews[0].id,
          openedById: s.ann.id,
          reason: 'I was right',
          answer: { labels: ['positive'] },
        },
      });
    });
    expect(await revising).toEqual({ ok: false, error: 'disputed' });
    expect(await stored(s)).toMatchObject({
      reviewStatus: 'SENT_BACK',
      answer: { labels: ['positive'] },
    });
  });
});

describe('settling a dispute', () => {
  beforeEach(resetDb);

  async function disputed(decide: (s: Setup) => Promise<unknown> = sendBack) {
    const s = await setup();
    await decide(s);
    await dispute(s);
    const { disputes, reviews, reviewedAt } = await stored(s);
    return { ...s, disputeId: disputes[0].id, decision: reviews[0], decidedAt: reviewedAt! };
  }

  it('is not for the reviewer who decided, the annotator, or people from elsewhere', async () => {
    const s = await disputed();
    const form = { intent: 'overturn', resolution: 'Ann is right' };

    expect(statusOf(await settle(s, s.disputeId, s.cookies.reviewer, form))).toBe(403);
    expect(statusOf(await settle(s, s.disputeId, s.cookies.ann, form))).toBe(403);
    const elsewhere = await createOrg('Elsewhere');
    const outsider = await createMember(elsewhere.id, 'ADMIN');
    const outside = await cookieFor(outsider, elsewhere.id);
    expect(statusOf(await settle(s, s.disputeId, outside, form))).toBe(404);
    // the model refuses by itself, whatever the route checked
    expect(
      await resolveDispute(s.disputeId, s.reviewer.id, {
        outcome: 'OVERTURNED',
        resolution: 'I change my mind',
      }),
    ).toEqual({ ok: false, error: 'own_decision' });

    expect(statusOf(await settle(s, s.disputeId, s.cookies.second, { intent: 'overturn' }))).toBe(
      400,
    );
    expect(await stored(s)).toMatchObject({
      reviewStatus: 'SENT_BACK',
      disputes: [{ status: 'OPEN', resolvedById: null }],
      reviews: [{ overturnedAt: null }],
    });

    const page = await run(
      disputeLoader,
      makeRequest(`/projects/${s.project.id}/disputes/${s.disputeId}`, {
        cookie: s.cookies.reviewer,
      }),
      { projectId: s.project.id, disputeId: s.disputeId },
    );
    expect(payload<{ barred: string }>(page).barred).toMatch(/You made this decision/);
  });

  it('does not let someone settle a dispute about their own work', async () => {
    const s = await setup();
    const admin = await createMember(s.org.id, 'ADMIN');
    const own = await submitWork(s.project, admin.id, { labels: ['positive'] });
    await run(
      reviewAction,
      makeRequest(`/review/${own.id}`, {
        cookie: s.cookies.reviewer,
        form: { intent: 'send_back', feedback: 'No' },
      }),
      { assignmentId: own.id },
    );
    const opened = await openDispute(own.id, admin.id, 'Yes');
    if (!opened.ok) throw new Error(opened.error);

    const result = await settle(s, opened.dispute.id, await cookieFor(admin, s.org.id), {
      intent: 'overturn',
      resolution: 'I agree with myself',
    });
    expect(statusOf(result)).toBe(403);
    expect(
      (await prisma.dispute.findUniqueOrThrow({ where: { id: opened.dispute.id } })).status,
    ).toBe('OPEN');
  });

  it('changes nothing but the dispute when the decision is upheld', async () => {
    const s = await disputed();

    const result = await settle(s, s.disputeId, s.cookies.second, {
      intent: 'uphold',
      resolution: 'The complaint is the main point of the review.',
    });
    expect(locationOf(result)).toBe(`/projects/${s.project.id}/disputes`);

    const after = await stored(s);
    expect(after).toMatchObject({ reviewStatus: 'SENT_BACK', reviewedAt: s.decidedAt });
    expect(after.reviews[0]).toEqual(s.decision);
    expect(after.disputes[0]).toMatchObject({
      status: 'UPHELD',
      resolvedById: s.second.id,
      resolution: 'The complaint is the main point of the review.',
    });
    const quality = await projectQuality(s.project);
    expect(quality.annotators[0]).toMatchObject({ reviewed: 1, sentBack: 1 });

    // the annotator sees the note and can revise again
    const mine = await run(myWorkLoader, makeRequest('/my-work', { cookie: s.cookies.ann }));
    expect(payload<{ items: unknown[] }>(mine).items[0]).toMatchObject({
      feedback: 'This one is negative.',
      qaScore: 2,
      dispute: { status: 'UPHELD', resolution: 'The complaint is the main point of the review.' },
    });
    expect(await resubmitAssignment(s.submission.id, s.ann.id, { labels: ['negative'] })).toEqual({
      ok: true,
    });
  });

  it('makes an overturned send-back approved work and dates it at the overturn', async () => {
    const s = await disputed();
    const overturnedAt = new Date(s.decidedAt.getTime() + 2 * 24 * 60 * 60_000);

    expect(
      await resolveDispute(
        s.disputeId,
        s.pm.id,
        { outcome: 'OVERTURNED', resolution: 'Ann read it correctly.' },
        overturnedAt,
      ),
    ).toEqual({ ok: true });

    const after = await stored(s);
    // dated at the overturn: that is the day the work became payable
    expect(after).toMatchObject({ reviewStatus: 'APPROVED', reviewedAt: overturnedAt });
    // the decision itself stays on record as it was made
    expect(after.reviews[0]).toEqual({ ...s.decision, overturnedAt });
    expect(after.disputes[0]).toMatchObject({
      status: 'OVERTURNED',
      reviewId: s.decision.id,
      resolvedById: s.pm.id,
      resolvedAt: overturnedAt,
    });

    const task = await prisma.task.findUniqueOrThrow({ where: { id: s.task.id } });
    expect(task).toMatchObject({ status: 'COMPLETE', consensus: { labels: ['positive'] } });
    // The report still selects by the day of submission, so that is where the
    // work shows up today. It follows `reviewedAt` once the report goes by
    // the day work became payable (roadmap item 5).
    const day = s.submission.submittedAt!.toISOString().slice(0, 10);
    const report = await payoutReport(s.org.id, { from: day, to: day });
    expect(report.lines).toMatchObject([{ name: 'Ann', tasks: 1 }]);
    expect(report.pending).toBe(0);

    // the overturned decision counts for nobody
    const quality = await projectQuality(s.project);
    expect(quality.annotators[0]).toMatchObject({
      reviewed: 0,
      sentBack: 0,
      reviewedSubmissions: 0,
      approvalRate: null,
      avgQaScore: null,
    });
    expect(await reviewerStats(s.reviewer.id, 7, overturnedAt)).toEqual({
      reviews: 0,
      sentBack: 0,
      fixed: 0,
      overturned: 1,
      avgScore: null,
    });
    const mine = await run(myWorkLoader, makeRequest('/my-work', { cookie: s.cookies.ann }));
    expect(payload<{ items: unknown[] }>(mine).items[0]).toMatchObject({
      reviewStatus: 'APPROVED',
      feedback: '',
      qaScore: null,
      dispute: { status: 'OVERTURNED', resolution: 'Ann read it correctly.' },
    });
  });

  it("puts the annotator's answer back when a fix is overturned, and keeps its date", async () => {
    const s = await disputed(fix);
    const before = await prisma.task.findUniqueOrThrow({ where: { id: s.task.id } });
    expect(before).toMatchObject({ status: 'COMPLETE', consensus: { labels: ['negative'] } });

    const result = await settle(s, s.disputeId, s.cookies.second, {
      intent: 'overturn',
      resolution: 'The original label was right.',
    });
    expect(statusOf(result)).toBe(302);

    const after = await stored(s);
    // accepted and payable since the review, so the date does not move
    expect(after).toMatchObject({ reviewStatus: 'APPROVED', reviewedAt: s.decidedAt });
    expect(after.reviews[0]).toMatchObject({
      decision: 'FIX',
      correctedAnswer: { labels: ['negative'] },
      qaScore: 2,
    });
    expect(after.reviews[0].overturnedAt).not.toBeNull();
    const task = await prisma.task.findUniqueOrThrow({ where: { id: s.task.id } });
    expect(task).toMatchObject({ status: 'COMPLETE', consensus: { labels: ['positive'] } });

    const download = (await run(
      downloadLoader,
      makeRequest(`/projects/${s.project.id}/download?format=jsonl`, { cookie: s.cookies.pm }),
      { projectId: s.project.id },
    )) as Response;
    const [row] = (await download.text())
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(row.consensus).toEqual({ labels: ['positive'] });
    expect(row.annotations).toMatchObject([
      { answer: { labels: ['positive'] }, review_status: 'approved', qa_score: null },
    ]);

    const page = await run(
      taskLoader,
      makeRequest(`/projects/${s.project.id}/tasks/${s.task.id}`, { cookie: s.cookies.pm }),
      { projectId: s.project.id, taskId: s.task.id },
    );
    expect(payload<{ assignments: unknown[] }>(page).assignments[0]).toMatchObject({
      answer: { labels: ['positive'] },
      corrected: false,
      reviews: [{ decision: 'FIX', overturned: true }],
    });
  });

  it('takes one outcome when two people settle at the same moment', async () => {
    const s = await disputed();

    const results = await Promise.all([
      settle(s, s.disputeId, s.cookies.second, { intent: 'uphold', resolution: 'Stands' }),
      settle(s, s.disputeId, s.cookies.pm, { intent: 'overturn', resolution: 'Ann is right' }),
    ]);

    expect(results.map(statusOf).sort()).toEqual([302, 409]);
    const after = await stored(s);
    if (after.disputes[0].status === 'OVERTURNED') {
      expect(after.reviewStatus).toBe('APPROVED');
      expect(after.reviews[0].overturnedAt).not.toBeNull();
      expect(after.disputes[0].resolvedById).toBe(s.pm.id);
    } else {
      expect(after.disputes[0]).toMatchObject({ status: 'UPHELD', resolvedById: s.second.id });
      expect(after).toMatchObject({ reviewStatus: 'SENT_BACK', reviews: [{ overturnedAt: null }] });
    }
  });

  it('leaves nothing behind when an overturn cannot be applied in full', async () => {
    const s = await disputed();
    // a state the app never produces: the work moved on under an open dispute
    await prisma.assignment.update({
      where: { id: s.submission.id },
      data: { reviewStatus: 'PENDING' },
    });

    await expect(
      resolveDispute(s.disputeId, s.pm.id, { outcome: 'OVERTURNED', resolution: 'Ann is right' }),
    ).rejects.toThrow(/not in the state/);

    expect(await stored(s)).toMatchObject({
      reviewStatus: 'PENDING',
      disputes: [{ status: 'OPEN', resolvedById: null, resolution: null, resolvedAt: null }],
      reviews: [{ overturnedAt: null }],
    });
  });

  it('keeps the disputed answer as stored work that a schema edit must respect', async () => {
    const s = await disputed();
    // while the submission still says the same, it is one stored answer, not two
    expect((await schemaUsage(s.project.id)).names.get('positive')).toBe(1);
    await settle(s, s.disputeId, s.cookies.second, { intent: 'uphold', resolution: 'Stands' });
    await resubmitAssignment(s.submission.id, s.ann.id, { labels: ['negative'] });

    // the submission no longer says "positive"; the dispute record still does
    const usage = await schemaUsage(s.project.id);
    expect(usage.names.get('positive')).toBe(1);
    expect(usage.names.get('negative')).toBe(1);
  });

  it('lists disputes for reviewers with the open count on the tab', async () => {
    const s = await disputed();
    const params = { projectId: s.project.id };
    const path = `/projects/${s.project.id}`;

    const layout = await run(layoutLoader, makeRequest(path, { cookie: s.cookies.second }), params);
    expect(payload<{ openDisputes: number }>(layout).openDisputes).toBe(1);
    const forAnnotator = await run(
      layoutLoader,
      makeRequest(path, { cookie: s.cookies.ann }),
      params,
    );
    expect(payload<{ openDisputes: number }>(forAnnotator).openDisputes).toBe(0);

    type List = { open: Array<{ id: string; canResolve: boolean }>; settled: unknown[] };
    const list = (cookie: string) =>
      run(disputesLoader, makeRequest(`${path}/disputes`, { cookie }), params);
    expect(payload<List>(await list(s.cookies.second))).toMatchObject({
      open: [{ id: s.disputeId, canResolve: true, annotator: 'Ann', reviewer: 'Rafael' }],
      settled: [],
    });
    expect(payload<List>(await list(s.cookies.reviewer)).open[0].canResolve).toBe(false);
    expect(statusOf(await list(s.cookies.ann))).toBe(403);

    await settle(s, s.disputeId, s.cookies.second, { intent: 'uphold', resolution: 'Stands' });
    expect(payload<List>(await list(s.cookies.pm))).toMatchObject({
      open: [],
      settled: [{ id: s.disputeId, status: 'UPHELD', resolver: 'Sam' }],
    });
  });
});

describe('a dispute always has a way out', () => {
  beforeEach(resetDb);

  it('is not opened when nobody but the deciding reviewer could settle it', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id);
    await createTasks(project.id, [{ text: 'one' }]);
    const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
    const reviewer = await createMember(org.id, 'REVIEWER', { name: 'Rafael' });
    // a reviewer of the organisation who is not on this project cannot open it
    const elsewhere = await createMember(org.id, 'REVIEWER', { name: 'Not here' });
    await addToProject(project.id, ann, reviewer);
    const submission = await submitWork(project, ann.id, { labels: ['positive'] });
    await run(
      reviewAction,
      makeRequest(`/review/${submission.id}`, {
        cookie: await cookieFor(reviewer, org.id),
        form: { intent: 'send_back', feedback: 'Negative.' },
      }),
      { assignmentId: submission.id },
    );
    const annCookie = await cookieFor(ann, org.id);
    const form = { intent: 'dispute', reason: 'I was right' };

    const refused = await postMyWork(submission.id, annCookie, form);
    expect(statusOf(refused)).toBe(409);
    expect(payload<{ error: string }>(refused).error).toMatch(/Nobody could settle a dispute/);
    expect(await prisma.dispute.count()).toBe(0);
    const page = await run(
      reviseLoader,
      makeRequest(`/my-work/${submission.id}`, { cookie: annCookie }),
      { assignmentId: submission.id },
    );
    expect(payload<{ disputeUntil: unknown; disputeClosed: string }>(page)).toMatchObject({
      disputeUntil: null,
      disputeClosed: expect.stringMatching(/Nobody could/),
    });
    // the work is not held up: it can still be revised
    expect(await resubmitAssignment(submission.id, ann.id, { labels: ['negative'] })).toEqual({
      ok: true,
    });

    // with a second reviewer on the project, or any manager, a dispute can be settled
    await prisma.assignment.update({
      where: { id: submission.id },
      data: { reviewStatus: 'SENT_BACK' },
    });
    await addToProject(project.id, elsewhere);
    expect(locationOf(await postMyWork(submission.id, annCookie, form))).toBe(
      `/my-work/${submission.id}`,
    );
  });

  it('lets the annotator withdraw: the work is where it was and can be revised to the end', async () => {
    const s = await setup();
    await sendBack(s);
    await dispute(s);
    const before = await stored(s);

    // nobody else can withdraw it
    const other = await createMember(s.org.id, 'ANNOTATOR');
    const form = { intent: 'withdraw-dispute' };
    expect(
      statusOf(await postMyWork(s.submission.id, await cookieFor(other, s.org.id), form)),
    ).toBe(404);
    expect(await withdrawDispute(s.submission.id, s.second.id)).toEqual({
      ok: false,
      error: 'not_open',
    });

    expect(locationOf(await postMyWork(s.submission.id, s.cookies.ann, form))).toBe(
      `/my-work/${s.submission.id}`,
    );
    const after = await stored(s);
    expect(after.disputes[0]).toMatchObject({
      status: 'WITHDRAWN',
      resolvedById: null,
      resolution: null,
    });
    expect(after.disputes[0].resolvedAt).not.toBeNull();
    // the decision stands and the submission is exactly as the review left it
    expect({ ...after, disputes: [] }).toEqual({ ...before, disputes: [] });

    // it is over: nobody settles it any more, and the decision is not disputed twice
    const late = await settle(s, after.disputes[0].id, s.cookies.second, {
      intent: 'overturn',
      resolution: 'Too late',
    });
    expect(statusOf(late)).toBe(409);
    expect(statusOf(await postMyWork(s.submission.id, s.cookies.ann, form))).toBe(409);
    expect(statusOf(await dispute(s))).toBe(409);

    // revise, get approved, and the task completes
    const revised = await postMyWork(s.submission.id, s.cookies.ann, {
      answer: '{"labels":["negative"]}',
    });
    expect(locationOf(revised)).toBe('/my-work?filter=returned');
    expect(statusOf(await review(s, { intent: 'approve' }))).toBe(302);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: s.task.id } });
    expect(task).toMatchObject({ status: 'COMPLETE', consensus: { labels: ['negative'] } });
  });

  it('leaves fixed work fixed when its dispute is withdrawn', async () => {
    const s = await setup();
    await fix(s);
    await dispute(s);

    expect(await withdrawDispute(s.submission.id, s.ann.id)).toEqual({ ok: true });

    const after = await stored(s);
    expect(after).toMatchObject({ reviewStatus: 'FIXED', reviews: [{ overturnedAt: null }] });
    const task = await prisma.task.findUniqueOrThrow({ where: { id: s.task.id } });
    expect(task).toMatchObject({ status: 'COMPLETE', consensus: { labels: ['negative'] } });
  });

  it('takes one of a withdrawal and an overturn that arrive at the same moment', async () => {
    const s = await setup();
    await sendBack(s);
    await dispute(s);
    const { disputes } = await stored(s);

    const [withdrawn, settled] = await Promise.all([
      withdrawDispute(s.submission.id, s.ann.id),
      resolveDispute(disputes[0].id, s.pm.id, { outcome: 'OVERTURNED', resolution: 'Right' }),
    ]);

    expect([withdrawn.ok, settled.ok].filter(Boolean)).toHaveLength(1);
    const after = await stored(s);
    if (withdrawn.ok) {
      expect(after).toMatchObject({
        reviewStatus: 'SENT_BACK',
        disputes: [{ status: 'WITHDRAWN' }],
        reviews: [{ overturnedAt: null }],
      });
    } else {
      expect(after).toMatchObject({
        reviewStatus: 'APPROVED',
        disputes: [{ status: 'OVERTURNED' }],
      });
      expect(after.reviews[0].overturnedAt).not.toBeNull();
    }
  });

  it('saves no revision while a dispute is open, and an overturn leaves no draft behind', async () => {
    const s = await setup();
    await sendBack(s);
    const draft = { labels: ['negative'] };
    expect(await saveRevisionDraft(s.submission.id, s.ann.id, draft)).toEqual({ ok: true });
    await dispute(s);

    // revising is refused while the dispute is open, and so is saving a revision
    expect(await saveRevisionDraft(s.submission.id, s.ann.id, { labels: ['positive'] })).toEqual({
      ok: false,
      error: 'disputed',
    });
    const request = makeRequest(`/my-work/${s.submission.id}/draft`, {
      cookie: s.cookies.ann,
      form: { draft: '{"labels":["positive"]}' },
    });
    request.headers.set('Origin', 'http://localhost');
    const refused = (await run(draftAction, request, {
      assignmentId: s.submission.id,
    })) as Response;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'disputed' });
    // what was saved before the dispute waits for its outcome
    expect((await stored(s)).draft).toEqual(draft);

    const { disputes } = await stored(s);
    await resolveDispute(disputes[0].id, s.pm.id, { outcome: 'OVERTURNED', resolution: 'Right' });
    expect(await stored(s)).toMatchObject({ reviewStatus: 'APPROVED', draft: null });
  });
});
