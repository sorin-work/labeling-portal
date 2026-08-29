import { beforeEach, describe, expect, it } from 'vitest';

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

type Report = {
  range: { from: string; to: string };
  totalCents: number;
  pending: number;
  lines: Array<{ name: string; tasks: number; amountCents: number }>;
};

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
