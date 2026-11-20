import { beforeEach, describe, expect, it } from 'vitest';

import { openDispute, resolveDispute, withdrawDispute } from '~/models/disputes.server';
import { resubmitAssignment, saveRevisionDraft } from '~/models/queue.server';
import { recordReview } from '~/models/reviews.server';
import { loader as earningsLoader } from '~/routes/earnings';
import { action as reviseDraftAction } from '~/routes/my-work-draft';
import { action as reviseAction, loader as reviseLoader } from '~/routes/my-work-revise';
import { loader as exportLoader } from '~/routes/payouts-export';
import { loader as payoutsLoader } from '~/routes/payouts';

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

type Block = {
  projectName: string;
  payMode: string;
  rateCents: number;
  tasks: number;
  seconds: number;
  amountCents: number;
};

type Report = {
  range: { from: string; to: string };
  totalCents: number;
  pending: number;
  lines: Array<{ name: string; tasks: number; amountCents: number; projects: Block[] }>;
};

type Part = { blocks: Block[]; tasks: number; seconds: number; totalCents: number };
type Earnings = { range: Report['range']; payable: Part; waiting: Part; sentBack: Part };

const MARCH = 'from=2026-03-01&to=2026-03-31';
const APRIL = 'from=2026-04-01&to=2026-04-30';

async function setup() {
  const org = await createOrg();
  const pm = await createMember(org.id, 'PROJECT_MANAGER');
  const project = await createTestProject(org.id, { reviewRequired: false });
  await prisma.project.update({ where: { id: project.id }, data: { rateCents: 35 } });
  await createTasks(project.id, [{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
  return { org, pm, project, ann, cookie: await cookieFor(pm, org.id) };
}

describe('payouts', () => {
  beforeEach(resetDb);

  it('totals accepted work in the range', async () => {
    const { project, ann, cookie } = await setup();
    await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-10T09:00:00Z') },
    );
    await submitWork(
      project,
      ann.id,
      { labels: ['negative'] },
      { now: new Date('2026-03-12T15:00:00Z') },
    );
    await submitWork(
      project,
      ann.id,
      { labels: ['negative'] },
      { now: new Date('2026-04-02T15:00:00Z') },
    );

    const result = await run(
      payoutsLoader,
      makeRequest('/payouts?from=2026-03-01&to=2026-03-31', { cookie }),
    );
    const report = payload<Report>(result);
    expect(report.lines).toEqual([
      expect.objectContaining({ name: 'Ann', tasks: 2, amountCents: 70 }),
    ]);
    expect(report.totalCents).toBe(70);
  });

  it('includes work from the whole last day of the range', async () => {
    const { project, ann, cookie } = await setup();
    await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-31T18:30:00Z') },
    );
    await submitWork(
      project,
      ann.id,
      { labels: ['negative'] },
      { now: new Date('2026-03-31T23:40:00Z') },
    );
    await submitWork(
      project,
      ann.id,
      { labels: ['negative'] },
      { now: new Date('2026-04-01T00:10:00Z') },
    );

    const report = payload<Report>(
      await run(payoutsLoader, makeRequest('/payouts?from=2026-03-01&to=2026-03-31', { cookie })),
    );
    expect(report.lines[0]).toMatchObject({ tasks: 2, amountCents: 70 });
  });

  it('can be limited to one project', async () => {
    const { org, project, ann, cookie } = await setup();
    const other = await createTestProject(org.id, { name: 'Other', reviewRequired: false });
    await prisma.project.update({ where: { id: other.id }, data: { rateCents: 100 } });
    await createTasks(other.id, [{ text: 'x' }]);
    const now = new Date('2026-03-10T09:00:00Z');
    await submitWork(project, ann.id, { labels: ['positive'] }, { now });
    await submitWork(other, ann.id, { labels: ['positive'] }, { now });

    const all = payload<Report>(
      await run(payoutsLoader, makeRequest('/payouts?from=2026-03-01&to=2026-03-31', { cookie })),
    );
    expect(all.totalCents).toBe(135);
    const one = payload<Report>(
      await run(
        payoutsLoader,
        makeRequest(`/payouts?from=2026-03-01&to=2026-03-31&project=${other.id}`, { cookie }),
      ),
    );
    expect(one.totalCents).toBe(100);
  });

  it('pays hourly projects for active time', async () => {
    const { project, ann, cookie } = await setup();
    await prisma.project.update({
      where: { id: project.id },
      data: { payMode: 'HOURLY', rateCents: 1800 },
    });
    const now = new Date('2026-03-10T09:00:00Z');
    await submitWork(project, ann.id, { labels: ['positive'] }, { now, activeSeconds: 120 });
    await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-11T09:00:00Z'), activeSeconds: 240 },
    );

    const result = await run(
      payoutsLoader,
      makeRequest('/payouts?from=2026-03-01&to=2026-03-31', { cookie }),
    );
    expect(payload<Report>(result).totalCents).toBe(180);
  });

  it('does not pay work that is still waiting for review', async () => {
    const { project, ann, cookie } = await setup();
    await prisma.project.update({ where: { id: project.id }, data: { reviewRequired: true } });
    await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-10T09:00:00Z') },
    );

    const report = payload<Report>(
      await run(payoutsLoader, makeRequest('/payouts?from=2026-03-01&to=2026-03-31', { cookie })),
    );
    expect(report.lines).toEqual([]);
    expect(report.pending).toBe(1);
  });

  it('swaps a reversed range and ignores bad dates', async () => {
    const { cookie } = await setup();
    const swapped = payload<Report>(
      await run(payoutsLoader, makeRequest('/payouts?from=2026-03-31&to=2026-03-01', { cookie })),
    );
    expect(swapped.range).toEqual({ from: '2026-03-01', to: '2026-03-31' });

    const bad = payload<Report>(
      await run(payoutsLoader, makeRequest('/payouts?from=2026-02-31', { cookie })),
    );
    expect(bad.range.from).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('exports csv', async () => {
    const { project, ann, cookie } = await setup();
    await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-10T09:00:00Z') },
    );

    const response = (await run(
      exportLoader,
      makeRequest('/payouts/export?from=2026-03-01&to=2026-03-31', { cookie }),
    )) as Response;
    expect(response.headers.get('Content-Disposition')).toContain(
      'payouts-2026-03-01-to-2026-03-31.csv',
    );
    const text = await response.text();
    expect(text.split('\r\n')[1]).toMatch(
      /^Ann,annotator-\d+@example\.test,Sentiment,per task,0\.35,1,/,
    );
  });

  it('is only for managers', async () => {
    const { org } = await setup();
    const reviewer = await createMember(org.id, 'REVIEWER');
    const result = await run(
      payoutsLoader,
      makeRequest('/payouts', { cookie: await cookieFor(reviewer, org.id) }),
    );
    expect(statusOf(result)).toBe(403);
  });
});

describe('rates frozen at submission', () => {
  beforeEach(resetDb);

  it('stores the rate and pay mode in the write that submits the work', async () => {
    const { project, ann } = await setup();

    const claimed = await prisma.assignment.findFirst({ where: { userId: ann.id } });
    expect(claimed).toBeNull();
    const submitted = await submitWork(project, ann.id, { labels: ['positive'] });

    expect(submitted).toMatchObject({ status: 'SUBMITTED', rateCents: 35, payMode: 'PER_TASK' });
  });

  it('is refused by the database when a submission has no rate', async () => {
    const { project, ann } = await setup();
    const [task] = await prisma.task.findMany({ where: { projectId: project.id } });
    const row = { projectId: project.id, taskId: task.id, userId: ann.id, expiresAt: new Date() };

    await expect(
      prisma.assignment.create({ data: { ...row, status: 'SUBMITTED' } }),
    ).rejects.toThrow(/Assignment_submitted_has_rate/);
    // a claim has no rate yet, and that is fine
    const claim = await prisma.assignment.create({ data: row });
    await expect(
      prisma.assignment.update({ where: { id: claim.id }, data: { status: 'SUBMITTED' } }),
    ).rejects.toThrow(/Assignment_submitted_has_rate/);
  });

  it('is refused by the database when accepted work has no payable date, or other work has one', async () => {
    const { project, ann } = await setup();
    const [task] = await prisma.task.findMany({ where: { projectId: project.id } });
    const at = new Date('2026-03-10T09:00:00Z');
    const submitted = {
      projectId: project.id,
      taskId: task.id,
      userId: ann.id,
      expiresAt: at,
      submittedAt: at,
      status: 'SUBMITTED' as const,
      rateCents: 35,
      payMode: 'PER_TASK' as const,
    };
    const refused = /Assignment_accepted_has_payable_date/;

    for (const reviewStatus of ['APPROVED', 'FIXED', 'NOT_REQUIRED'] as const) {
      await expect(
        prisma.assignment.create({ data: { ...submitted, reviewStatus } }),
      ).rejects.toThrow(refused);
    }
    for (const reviewStatus of ['PENDING', 'SENT_BACK'] as const) {
      await expect(
        prisma.assignment.create({ data: { ...submitted, reviewStatus, payableAt: at } }),
      ).rejects.toThrow(refused);
    }
    // accepting work in a write that forgets the date is refused as well
    const pending = await prisma.assignment.create({
      data: { ...submitted, reviewStatus: 'PENDING' },
    });
    await expect(
      prisma.assignment.update({ where: { id: pending.id }, data: { reviewStatus: 'APPROVED' } }),
    ).rejects.toThrow(refused);
  });

  it('takes the rate that is committed when the submission is written', async () => {
    const { project, ann } = await setup();
    const { claimNextTask, submitAssignment } = await import('~/models/queue.server');
    const claimedAt = new Date(Date.now() - 10 * 60_000);
    const claim = await claimNextTask(project, ann.id, claimedAt);
    if (!claim.ok) throw new Error(claim.reason);

    // a settings save has changed the rate and is about to commit
    let commit = () => {};
    const changed = new Promise<void>((resolve) => (commit = resolve));
    let updated = () => {};
    const rateIsWritten = new Promise<void>((resolve) => (updated = resolve));
    const saving = prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: project.id }, data: { rateCents: 50 } });
      updated();
      await changed;
    });
    await rateIsWritten;

    const submitting = submitAssignment(claim.assignment.id, ann.id, {
      answer: { labels: ['positive'] },
      activeSeconds: 30,
      reviewRequired: false,
    });
    // the submission waits for the save instead of going ahead with the old rate
    const first = await Promise.race([
      submitting.then(() => 'submitted'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
    ]);
    expect(first).toBe('waiting');
    commit();
    await saving;

    const result = await submitting;
    expect(result.ok && result.assignment).toMatchObject({ rateCents: 50, payMode: 'PER_TASK' });
  });

  it('leaves earlier work alone when the rate changes', async () => {
    const { project, ann, cookie } = await setup();
    const first = await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-10T09:00:00Z') },
    );
    await prisma.project.update({ where: { id: project.id }, data: { rateCents: 50 } });
    await submitWork(
      project,
      ann.id,
      { labels: ['negative'] },
      { now: new Date('2026-03-12T09:00:00Z') },
    );
    // and later the project moves to hourly pay altogether
    await prisma.project.update({
      where: { id: project.id },
      data: { payMode: 'HOURLY', rateCents: 1800 },
    });

    const report = payload<Report>(
      await run(payoutsLoader, makeRequest(`/payouts?${MARCH}`, { cookie })),
    );
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].projects).toEqual([
      expect.objectContaining({ payMode: 'PER_TASK', rateCents: 35, tasks: 1, amountCents: 35 }),
      expect.objectContaining({ payMode: 'PER_TASK', rateCents: 50, tasks: 1, amountCents: 50 }),
    ]);
    expect(report.totalCents).toBe(85);
    expect(await prisma.assignment.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      rateCents: 35,
      payMode: 'PER_TASK',
    });

    // the project shows as two lines in the csv as well
    const csv = await (
      (await run(exportLoader, makeRequest(`/payouts/export?${MARCH}`, { cookie }))) as Response
    ).text();
    const rows = csv.trim().split('\r\n').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/,Sentiment,per task,0\.35,1,0\.01,0\.35$/);
    expect(rows[1]).toMatch(/,Sentiment,per task,0\.50,1,0\.01,0\.50$/);
  });
});

describe('the day work becomes payable', () => {
  beforeEach(resetDb);

  async function withReview() {
    const base = await setup();
    await prisma.project.update({ where: { id: base.project.id }, data: { reviewRequired: true } });
    const reviewer = await createMember(base.org.id, 'REVIEWER');
    const report = async (range: string) =>
      payload<Report>(
        await run(payoutsLoader, makeRequest(`/payouts?${range}`, { cookie: base.cookie })),
      );
    return { ...base, reviewer, report };
  }

  it('counts reviewed work in the month it was approved, not the month it was submitted', async () => {
    const { project, ann, reviewer, report } = await withReview();
    const submission = await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-30T09:00:00Z') },
    );
    expect(await report(MARCH)).toMatchObject({ lines: [], totalCents: 0, pending: 1 });

    await recordReview(
      submission.id,
      reviewer.id,
      { decision: 'APPROVE', qaScore: 5, feedback: '' },
      new Date('2026-04-02T10:00:00Z'),
    );

    // March was closed without it and stays that way
    expect(await report(MARCH)).toMatchObject({ lines: [], totalCents: 0, pending: 0 });
    const april = await report(APRIL);
    expect(april.lines).toEqual([
      expect.objectContaining({ name: 'Ann', tasks: 1, amountCents: 35 }),
    ]);
    expect(april.totalCents).toBe(35);
  });

  it('pays work the review sample lets through from the day it was submitted', async () => {
    const { project, ann, report } = await withReview();
    await prisma.project.update({ where: { id: project.id }, data: { reviewSamplePercent: 0 } });
    // ten reviewed submissions in January: from then on the sample decides
    const earlier = await createTasks(
      project.id,
      Array.from({ length: 10 }, (_, i) => ({ text: `earlier ${i}` })),
    );
    const january = new Date('2026-01-10T09:00:00Z');
    await prisma.assignment.createMany({
      data: earlier.map((task) => ({
        projectId: project.id,
        taskId: task.id,
        userId: ann.id,
        status: 'SUBMITTED' as const,
        claimedAt: january,
        expiresAt: january,
        submittedAt: january,
        reviewStatus: 'APPROVED' as const,
        reviewedAt: january,
        payableAt: january,
        answer: { labels: ['positive'] },
        rateCents: 35,
        payMode: 'PER_TASK' as const,
      })),
    });

    const submission = await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-30T09:00:00Z') },
    );

    // not drawn: accepted at once, with the rate frozen in the same write
    expect(submission).toMatchObject({
      reviewStatus: 'NOT_REQUIRED',
      reviewSample: 'NOT_DRAWN',
      reviewedAt: null,
      rateCents: 35,
      payMode: 'PER_TASK',
    });
    expect(await report(MARCH)).toMatchObject({ totalCents: 35, pending: 0 });
    expect((await report(APRIL)).totalCents).toBe(0);
  });

  it('leaves work that was accepted before the cutover in the period it was submitted in', async () => {
    const { project, ann, report } = await withReview();
    const [task] = await prisma.task.findMany({ where: { projectId: project.id } });
    // what the migration leaves behind for old work: submitted in March,
    // approved in April, and dated by its submission as the old report had it
    const submittedAt = new Date('2026-03-30T09:00:00Z');
    await prisma.assignment.create({
      data: {
        projectId: project.id,
        taskId: task.id,
        userId: ann.id,
        status: 'SUBMITTED',
        claimedAt: submittedAt,
        expiresAt: submittedAt,
        submittedAt,
        reviewStatus: 'APPROVED',
        reviewedAt: new Date('2026-04-02T10:00:00Z'),
        payableAt: submittedAt,
        answer: { labels: ['positive'] },
        rateCents: 35,
        payMode: 'PER_TASK',
      },
    });

    expect(await report(MARCH)).toMatchObject({ totalCents: 35, pending: 0 });
    expect((await report(APRIL)).totalCents).toBe(0);
  });

  it('counts a reviewer fix like an approval, and never pays sent-back work', async () => {
    const { project, ann, reviewer, report } = await withReview();
    const now = new Date('2026-03-30T09:00:00Z');
    const fixed = await submitWork(project, ann.id, { labels: ['positive'] }, { now });
    const returned = await submitWork(project, ann.id, { labels: ['positive'] }, { now });
    const reviewedAt = new Date('2026-04-02T10:00:00Z');
    await recordReview(
      fixed.id,
      reviewer.id,
      { decision: 'FIX', qaScore: 3, feedback: '', correctedAnswer: { labels: ['negative'] } },
      reviewedAt,
    );
    await recordReview(
      returned.id,
      reviewer.id,
      { decision: 'SEND_BACK', qaScore: 2, feedback: 'again' },
      reviewedAt,
    );

    expect((await report(APRIL)).totalCents).toBe(35);
    // sent back in March's submissions: waiting, not owed
    expect(await report(MARCH)).toMatchObject({ totalCents: 0, pending: 1 });
  });

  it('dates a dispute outcome the way the work became payable', async () => {
    const { project, pm, ann, reviewer, report } = await withReview();
    const now = new Date('2026-03-20T09:00:00Z');
    const answer = { labels: ['positive'] };
    const returned = await submitWork(project, ann.id, answer, { now });
    const fixed = await submitWork(project, ann.id, answer, { now });
    const kept = await submitWork(project, ann.id, answer, { now });
    const decidedAt = new Date('2026-03-25T09:00:00Z');
    const sendBack = { decision: 'SEND_BACK' as const, qaScore: 2, feedback: 'again' };
    await recordReview(returned.id, reviewer.id, sendBack, decidedAt);
    await recordReview(kept.id, reviewer.id, sendBack, decidedAt);
    await recordReview(
      fixed.id,
      reviewer.id,
      { decision: 'FIX', qaScore: 3, feedback: '', correctedAnswer: { labels: ['negative'] } },
      decidedAt,
    );

    const disputedAt = new Date('2026-03-26T09:00:00Z');
    const open = async (assignmentId: string) => {
      const opened = await openDispute(assignmentId, ann.id, 'It is positive.', disputedAt);
      if (!opened.ok) throw new Error(opened.error);
      return opened.dispute.id;
    };
    const aboutReturned = await open(returned.id);
    const aboutFixed = await open(fixed.id);
    await open(kept.id);
    // an open dispute changes nothing: the fix is payable, the send-backs are not
    expect(await report(MARCH)).toMatchObject({ totalCents: 35, pending: 2 });

    const settledAt = new Date('2026-04-02T09:00:00Z');
    const overturn = { outcome: 'OVERTURNED' as const, resolution: 'Ann read it correctly.' };
    expect(await resolveDispute(aboutReturned, pm.id, overturn, settledAt)).toEqual({ ok: true });
    expect(await resolveDispute(aboutFixed, pm.id, overturn, settledAt)).toEqual({ ok: true });
    expect(await withdrawDispute(kept.id, ann.id, settledAt)).toEqual({ ok: true });

    // The overturned fix was accepted and payable since its review in March
    // and stays there. The withdrawn dispute left its work sent back.
    const march = await report(MARCH);
    expect(march.lines).toEqual([expect.objectContaining({ tasks: 1, amountCents: 35 })]);
    expect(march.pending).toBe(1);
    // The overturned send-back became payable in April, and only there.
    const april = await report(APRIL);
    expect(april.lines).toEqual([expect.objectContaining({ tasks: 1, amountCents: 35 })]);
    // each piece of work is paid once over the two months
    const both = payload<Report>(
      await run(
        payoutsLoader,
        makeRequest('/payouts?from=2026-03-01&to=2026-04-30', {
          cookie: await cookieFor(pm, project.orgId),
        }),
      ),
    );
    expect(both).toMatchObject({ totalCents: 70, pending: 1 });
    expect(both.lines[0].tasks).toBe(2);
  });

  it('counts the time spent revising, capped at the time since the review', async () => {
    const { project, ann, reviewer, report } = await withReview();
    await prisma.project.update({
      where: { id: project.id },
      data: { payMode: 'HOURLY', rateCents: 1800 },
    });
    const submission = await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-10T09:00:00Z'), activeSeconds: 120 },
    );
    await recordReview(
      submission.id,
      reviewer.id,
      { decision: 'SEND_BACK', qaScore: 2, feedback: 'Look again.' },
      new Date('2026-03-10T10:00:00Z'),
    );
    // by now the project pays less; the frozen rate stays
    await prisma.project.update({ where: { id: project.id }, data: { rateCents: 900 } });

    // four minutes after the review the browser claims far more than that
    const resubmit = () =>
      resubmitAssignment(
        submission.id,
        ann.id,
        { answer: { labels: ['negative'] }, activeSeconds: 99_999 },
        new Date('2026-03-10T10:04:00Z'),
      );
    expect(await resubmit()).toEqual({ ok: true });
    // the same form posted again adds nothing
    expect(await resubmit()).toEqual({ ok: false, error: 'not_active' });
    expect(
      await prisma.assignment.findUniqueOrThrow({ where: { id: submission.id } }),
    ).toMatchObject({ activeSeconds: 120 + 240, rateCents: 1800, payMode: 'HOURLY' });

    await recordReview(
      submission.id,
      reviewer.id,
      { decision: 'APPROVE', qaScore: 4, feedback: '' },
      new Date('2026-03-11T08:00:00Z'),
    );
    // 360 seconds at $18 an hour
    expect((await report(MARCH)).totalCents).toBe(180);
  });

  it('credits a revision no more than the time limit, whatever the routes are sent', async () => {
    const { org, project, ann, reviewer, report } = await withReview();
    await prisma.project.update({
      where: { id: project.id },
      data: { payMode: 'HOURLY', rateCents: 2000, timeLimitMinutes: 30 },
    });
    const submission = await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-10T09:00:00Z'), activeSeconds: 120 },
    );
    // sent back five days ago; revising has no deadline of its own
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60_000);
    await recordReview(
      submission.id,
      reviewer.id,
      { decision: 'SEND_BACK', qaScore: 2, feedback: 'Look again.' },
      fiveDaysAgo,
    );
    const cookie = await cookieFor(ann, org.id);
    const path = `/my-work/${submission.id}`;
    const params = { assignmentId: submission.id };
    const stored = () => prisma.assignment.findUniqueOrThrow({ where: { id: submission.id } });

    // the draft route is posted a time no browser could have counted
    const saved = (await run(
      reviseDraftAction,
      makeRequest(`${path}/draft`, { cookie, form: { activeSeconds: '9999999' } }),
      params,
    )) as Response;
    expect(await saved.json()).toEqual({ ok: true, draftSeconds: 30 * 60 });
    expect(await stored()).toMatchObject({ activeSeconds: 120, draftSeconds: 30 * 60 });

    // and so is the form that hands the revision in
    await run(
      reviseAction,
      makeRequest(path, {
        cookie,
        form: { answer: JSON.stringify({ labels: ['negative'] }), activeSeconds: '9999999' },
      }),
      params,
    );
    expect(await stored()).toMatchObject({
      reviewStatus: 'PENDING',
      activeSeconds: 120 + 30 * 60,
      draftSeconds: 0,
    });

    await recordReview(
      submission.id,
      reviewer.id,
      { decision: 'APPROVE', qaScore: 4, feedback: '' },
      new Date('2026-03-20T09:00:00Z'),
    );
    // 32 minutes at $20 an hour, not five days of it
    expect((await report(MARCH)).totalCents).toBe(1067);
  });

  it('credits an assignment no more than three time limits, however often it is sent back', async () => {
    const { project, ann, reviewer } = await withReview();
    await prisma.project.update({ where: { id: project.id }, data: { timeLimitMinutes: 30 } });
    const submission = await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-01T09:00:00Z'), activeSeconds: 120 },
    );
    const credited = [];
    for (let round = 1; round <= 5; round++) {
      const day = String(round + 1).padStart(2, '0');
      await recordReview(
        submission.id,
        reviewer.id,
        { decision: 'SEND_BACK', qaScore: 2, feedback: 'Again.' },
        new Date(`2026-03-${day}T09:00:00Z`),
      );
      // a day later each time, with a count far beyond it
      expect(
        await resubmitAssignment(
          submission.id,
          ann.id,
          { answer: { labels: ['negative'] }, activeSeconds: 9_999_999 },
          new Date(`2026-03-${day}T21:00:00Z`),
        ),
      ).toEqual({ ok: true });
      const { activeSeconds } = await prisma.assignment.findUniqueOrThrow({
        where: { id: submission.id },
      });
      credited.push(activeSeconds);
    }
    // 120 seconds at first, then a limit per revision until three limits are reached
    expect(credited).toEqual([1920, 3720, 5400, 5400, 5400]);
  });

  it('takes the revising time from the form', async () => {
    const { org, project, ann, reviewer } = await withReview();
    const submission = await submitWork(project, ann.id, { labels: ['positive'] });
    await recordReview(
      submission.id,
      reviewer.id,
      { decision: 'SEND_BACK', qaScore: 2, feedback: 'Look again.' },
      new Date(Date.now() - 10 * 60_000),
    );

    await run(
      reviseAction,
      makeRequest(`/my-work/${submission.id}`, {
        cookie: await cookieFor(ann, org.id),
        form: { answer: JSON.stringify({ labels: ['negative'] }), activeSeconds: '45' },
      }),
      { assignmentId: submission.id },
    );

    expect(
      await prisma.assignment.findUniqueOrThrow({ where: { id: submission.id } }),
    ).toMatchObject({ reviewStatus: 'PENDING', activeSeconds: 30 + 45 });
  });
});

describe('revising time and drafts', () => {
  beforeEach(resetDb);

  it('keeps the revising time with the draft, so a reload does not lose it', async () => {
    const { org, project, ann } = await setup();
    await prisma.project.update({ where: { id: project.id }, data: { reviewRequired: true } });
    const reviewer = await createMember(org.id, 'REVIEWER');
    const submission = await submitWork(project, ann.id, { labels: ['positive'] });
    const sentBackAt = new Date(Date.now() - 10 * 60_000);
    await recordReview(
      submission.id,
      reviewer.id,
      { decision: 'SEND_BACK', qaScore: 2, feedback: 'Look again.' },
      sentBackAt,
    );
    const cookie = await cookieFor(ann, org.id);
    const path = `/my-work/${submission.id}`;
    const params = { assignmentId: submission.id };
    const saveTime = async (activeSeconds: string) => {
      const response = (await run(
        reviseDraftAction,
        makeRequest(`${path}/draft`, { cookie, form: { activeSeconds } }),
        params,
      )) as Response;
      return { status: response.status, body: await response.json() };
    };

    // the page saves its time every half minute, without a changed answer
    expect(await saveTime('40')).toEqual({ status: 200, body: { ok: true, draftSeconds: 40 } });
    // an older tab cannot take seconds away
    expect((await saveTime('25')).body).toEqual({ ok: true, draftSeconds: 40 });
    // and four minutes after the review nobody has spent more than four minutes
    expect(
      await saveRevisionDraft(
        submission.id,
        ann.id,
        { activeSeconds: 99_999 },
        new Date(sentBackAt.getTime() + 240_000),
      ),
    ).toEqual({ ok: true, draftSeconds: 240 });

    // after a reload the page counts on from there
    const page = payload<{ draftSeconds: number }>(
      await run(reviseLoader, makeRequest(path, { cookie }), params),
    );
    expect(page.draftSeconds).toBe(240);

    // and a form that lost its count still hands in what was saved
    await run(
      reviseAction,
      makeRequest(path, {
        cookie,
        form: { answer: JSON.stringify({ labels: ['negative'] }), activeSeconds: '0' },
      }),
      params,
    );
    expect(
      await prisma.assignment.findUniqueOrThrow({ where: { id: submission.id } }),
    ).toMatchObject({
      reviewStatus: 'PENDING',
      activeSeconds: 30 + 240,
      draft: null,
      draftSeconds: 0,
    });
  });
});

describe('earnings', () => {
  beforeEach(resetDb);

  const earnings = async (user: { id: string }, orgId: string, query: string) =>
    payload<Earnings>(
      await run(
        earningsLoader,
        makeRequest(`/earnings?${query}`, { cookie: await cookieFor(user, orgId) }),
      ),
    );

  it('shows an annotator their own work only, whatever the request asks for', async () => {
    const { org, project, ann, cookie } = await setup();
    const ben = await createMember(org.id, 'ANNOTATOR', { name: 'Ben' });
    const day = (d: number) => ({ now: new Date(`2026-03-${d}T09:00:00Z`) });
    await submitWork(project, ann.id, { labels: ['positive'] }, day(10));
    await submitWork(project, ben.id, { labels: ['positive'] }, day(10));
    await submitWork(project, ann.id, { labels: ['negative'] }, day(11));

    const mine = await earnings(ann, org.id, MARCH);
    expect(mine.payable).toEqual({
      blocks: [
        expect.objectContaining({
          projectName: 'Sentiment',
          payMode: 'PER_TASK',
          rateCents: 35,
          tasks: 2,
          amountCents: 70,
        }),
      ],
      tasks: 2,
      seconds: 60,
      totalCents: 70,
    });
    // naming someone else changes nothing: the page knows only the session
    expect(await earnings(ann, org.id, `${MARCH}&user=${ben.id}&userId=${ben.id}`)).toEqual(mine);
    expect((await earnings(ben, org.id, MARCH)).payable.totalCents).toBe(35);

    // the same numbers as the manager's report has for her
    const report = payload<Report>(
      await run(payoutsLoader, makeRequest(`/payouts?${MARCH}`, { cookie })),
    );
    expect(report.lines.find((line) => line.name === 'Ann')).toMatchObject({
      amountCents: mine.payable.totalCents,
      projects: mine.payable.blocks,
    });
    expect(report.totalCents).toBe(105);
  });

  it('keeps another organisation and people without work out of it', async () => {
    const { org, project, ann } = await setup();
    await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-10T09:00:00Z') },
    );
    const reviewer = await createMember(org.id, 'REVIEWER');
    const empty = { blocks: [], tasks: 0, seconds: 0, totalCents: 0 };

    // any signed-in person may open the page; it is their own, and empty here
    expect(await earnings(reviewer, org.id, MARCH)).toMatchObject({
      payable: empty,
      waiting: empty,
      sentBack: empty,
    });
    // the same person signed in to another organisation sees none of this one
    const other = await createOrg('Other');
    await prisma.membership.create({
      data: { orgId: other.id, userId: ann.id, role: 'ANNOTATOR' },
    });
    expect((await earnings(ann, other.id, MARCH)).payable).toEqual(empty);

    const signedOut = await run(earningsLoader, makeRequest(`/earnings?${MARCH}`));
    expect(statusOf(signedOut)).toBe(302);
  });

  it('says what is payable, what waits for review and what was sent back', async () => {
    const { org, project, ann } = await setup();
    await prisma.project.update({ where: { id: project.id }, data: { reviewRequired: true } });
    const reviewer = await createMember(org.id, 'REVIEWER');
    const submit = (iso: string) =>
      submitWork(project, ann.id, { labels: ['positive'] }, { now: new Date(iso) });
    // waiting since January, far outside the range that is asked for
    await submit('2026-01-05T09:00:00Z');
    const returned = await submit('2026-01-06T09:00:00Z');
    await recordReview(
      returned.id,
      reviewer.id,
      { decision: 'SEND_BACK', qaScore: 2, feedback: 'again' },
      new Date('2026-01-07T09:00:00Z'),
    );
    const approved = await submit('2026-03-10T09:00:00Z');
    await recordReview(
      approved.id,
      reviewer.id,
      { decision: 'APPROVE', qaScore: 5, feedback: '' },
      new Date('2026-03-11T09:00:00Z'),
    );

    const page = await earnings(ann, org.id, MARCH);
    expect(page.payable).toMatchObject({ tasks: 1, totalCents: 35 });
    expect(page.waiting).toMatchObject({ tasks: 1, totalCents: 35 });
    expect(page.sentBack).toMatchObject({ tasks: 1, totalCents: 35 });

    // nothing became payable in April, and the waiting work is still listed
    const later = await earnings(ann, org.id, APRIL);
    expect(later.payable).toMatchObject({ tasks: 0, totalCents: 0 });
    expect(later.waiting.tasks + later.sentBack.tasks).toBe(2);
  });
});
