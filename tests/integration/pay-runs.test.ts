import { beforeEach, describe, expect, it } from 'vitest';

import { closePayRun } from '~/models/pay-runs.server';
import { payoutReport } from '~/models/payouts.server';
import { loader as earningsLoader } from '~/routes/earnings';
import { action as payoutsAction } from '~/routes/payouts';
import { loader as runExportLoader } from '~/routes/payouts-run-export';

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

const MARCH = { from: '2026-03-01', to: '2026-03-31' };
const APRIL = { from: '2026-04-01', to: '2026-04-30' };
const AFTER = new Date('2026-05-02T10:00:00Z');

/** Three tasks accepted without review in March, at 35 cents each. */
async function setup() {
  const org = await createOrg();
  const admin = await createMember(org.id, 'ADMIN', { name: 'Ada' });
  const pm = await createMember(org.id, 'PROJECT_MANAGER');
  const project = await createTestProject(org.id, { reviewRequired: false });
  await prisma.project.update({ where: { id: project.id }, data: { rateCents: 35 } });
  await createTasks(project.id, [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]);
  const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
  const work = [];
  for (const day of ['2026-03-05', '2026-03-12', '2026-03-20']) {
    work.push(
      await submitWork(
        project,
        ann.id,
        { labels: ['positive'] },
        { now: new Date(`${day}T09:00:00Z`) },
      ),
    );
  }
  return { org, admin, pm, project, ann, work };
}

describe('closing a pay period', () => {
  beforeEach(resetDb);

  it('copies the report into a run, marks the work and records who did it', async () => {
    const s = await setup();
    const report = await payoutReport(s.org.id, MARCH);
    const closed = await closePayRun(s.org.id, s.admin.id, MARCH, 'Bank transfer', AFTER);
    if (!closed.ok) throw new Error(closed.error);
    expect(closed.totalCents).toBe(report.totalCents);
    expect(closed.totalCents).toBe(105);
    const runRow = await prisma.payRun.findUniqueOrThrow({
      where: { id: closed.runId },
      include: { lines: true },
    });
    expect(runRow).toMatchObject({ closedByName: 'Ada', note: 'Bank transfer', totalCents: 105 });
    expect(runRow.lines).toMatchObject([{ name: 'Ann', tasks: 3, amountCents: 105 }]);
    expect(await prisma.assignment.count({ where: { payRunId: closed.runId } })).toBe(3);
    expect(
      await prisma.activity.count({ where: { orgId: s.org.id, action: 'payrun.closed' } }),
    ).toBe(1);
  });

  it('refuses a period that is not over and one that overlaps a run', async () => {
    const s = await setup();
    expect(
      await closePayRun(s.org.id, s.admin.id, MARCH, '', new Date('2026-03-31T23:00:00Z')),
    ).toEqual({
      ok: false,
      error: 'not_over',
    });
    expect((await closePayRun(s.org.id, s.admin.id, MARCH, '', AFTER)).ok).toBe(true);
    expect(
      await closePayRun(s.org.id, s.admin.id, { from: '2026-03-31', to: '2026-04-10' }, '', AFTER),
    ).toEqual({ ok: false, error: 'overlap' });
    // the next period is fine and takes none of March's work
    const april = await closePayRun(s.org.id, s.admin.id, APRIL, '', AFTER);
    expect(april).toMatchObject({ ok: true, totalCents: 0 });
  });

  it('is for admins: a project manager may not close a period', async () => {
    const s = await setup();
    const post = (cookie: string) =>
      run(payoutsAction, makeRequest('/payouts', { cookie, form: { ...MARCH } }));
    expect(statusOf(await post(await cookieFor(s.pm, s.org.id)))).toBe(403);
    expect(await prisma.payRun.count()).toBe(0);
  });

  it('never changes a closed run, its lines or what its work was paid for', async () => {
    const s = await setup();
    const closed = await closePayRun(s.org.id, s.admin.id, MARCH, '', AFTER);
    if (!closed.ok) throw new Error(closed.error);
    await expect(
      prisma.payRun.update({ where: { id: closed.runId }, data: { totalCents: 1 } }),
    ).rejects.toThrow();
    await expect(
      prisma.payRunLine.deleteMany({ where: { payRunId: closed.runId } }),
    ).rejects.toThrow();
    await expect(
      prisma.assignment.update({ where: { id: s.work[0].id }, data: { activeSeconds: 9999 } }),
    ).rejects.toThrow();
    await expect(
      prisma.assignment.update({ where: { id: s.work[0].id }, data: { payRunId: null } }),
    ).rejects.toThrow();
    // a gold score or a review status that stays accepted may still change
    await prisma.assignment.update({ where: { id: s.work[0].id }, data: { goldScore: 1 } });
  });

  it('pays work that becomes payable on a closed day in the next run instead', async () => {
    const s = await setup();
    const closed = await closePayRun(s.org.id, s.admin.id, MARCH, '', AFTER);
    if (!closed.ok) throw new Error(closed.error);
    // a fourth task, its payable date set into March after the close (as a
    // resubmission that keeps the date of its first submission does)
    const late = await submitWork(s.project, s.ann.id, { labels: ['positive'] });
    await prisma.assignment.update({
      where: { id: late.id },
      data: { payableAt: new Date('2026-03-15T12:00:00Z') },
    });
    const moved = await prisma.assignment.findUniqueOrThrow({ where: { id: late.id } });
    expect(moved.payRunId).toBeNull();
    expect(moved.payableAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // March is unchanged, and the work is owed in the open period
    expect(
      (await prisma.payRun.findUniqueOrThrow({ where: { id: closed.runId } })).totalCents,
    ).toBe(105);
    expect(await prisma.assignment.count({ where: { payRunId: closed.runId } })).toBe(3);
  });

  it('keeps the CSV of a run as it was, and earnings show the work as paid', async () => {
    const s = await setup();
    const closed = await closePayRun(s.org.id, s.admin.id, MARCH, '', AFTER);
    if (!closed.ok) throw new Error(closed.error);
    await prisma.project.update({
      where: { id: s.project.id },
      data: { name: 'Renamed', rateCents: 99 },
    });
    const cookie = await cookieFor(s.admin, s.org.id);
    const response = (await run(
      runExportLoader,
      makeRequest(`/payouts/runs/${closed.runId}/export`, { cookie }),
      { runId: closed.runId },
    )) as Response;
    const csv = await response.text();
    expect(csv).toContain('Sentiment');
    expect(csv).not.toContain('Renamed');
    expect(csv).toContain('1.05');

    // another organisation's admin cannot read it
    const other = await createOrg('Other');
    const stranger = await createMember(other.id, 'ADMIN');
    const refused = await run(
      runExportLoader,
      makeRequest(`/payouts/runs/${closed.runId}/export`, {
        cookie: await cookieFor(stranger, other.id),
      }),
      { runId: closed.runId },
    );
    expect(statusOf(refused)).toBe(404);

    const earnings = await run(
      earningsLoader,
      makeRequest('/earnings?from=2026-03-01&to=2026-03-31', {
        cookie: await cookieFor(s.ann, s.org.id),
      }),
    );
    const split = payload<{
      split: { unpaid: { tasks: number }; paid: Array<{ runId: string; tasks: number }> };
    }>(earnings).split;
    expect(split.unpaid.tasks).toBe(0);
    expect(split.paid).toMatchObject([{ runId: closed.runId, tasks: 3 }]);
  });
});
