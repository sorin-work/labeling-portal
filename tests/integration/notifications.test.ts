import { beforeEach, describe, expect, it } from 'vitest';

import { openDispute, resolveDispute } from '~/models/disputes.server';
import { applyRescore, previewRescore } from '~/models/gold.server';
import { openNotifications } from '~/models/notifications.server';
import { claimNextTask, releaseClaim } from '~/models/queue.server';
import { recordReview } from '~/models/reviews.server';
import { loader as layoutLoader } from '~/routes/app-layout';
import { loader as notificationsLoader } from '~/routes/notifications';

import {
  addToProject,
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
  submitWork,
} from './helpers';

async function setup() {
  const org = await createOrg();
  const project = await createTestProject(org.id, { name: 'Sentiment' });
  await createTasks(project.id, [{ text: 'one' }, { text: 'two' }]);
  const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
  const reviewer = await createMember(org.id, 'REVIEWER', { name: 'Rafael' });
  const pm = await createMember(org.id, 'PROJECT_MANAGER', { name: 'Priya' });
  const admin = await createMember(org.id, 'ADMIN', { name: 'Ada' });
  await addToProject(project.id, ann, reviewer);
  return { org, project, ann, reviewer, pm, admin };
}

const mine = (userId: string) =>
  prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

describe('notifications', () => {
  beforeEach(resetDb);

  it('tells the annotator about a send-back or a fix, not an approval, and a refused review writes none', async () => {
    const s = await setup();
    const first = await submitWork(s.project, s.ann.id, { labels: ['positive'] });
    await recordReview(first.id, s.reviewer.id, {
      decision: 'SEND_BACK',
      qaScore: 2,
      feedback: 'No.',
    });
    // the same submission again: refused, and nobody is told twice
    const refused = await recordReview(first.id, s.reviewer.id, {
      decision: 'SEND_BACK',
      qaScore: 2,
      feedback: 'No.',
    });
    expect(refused.ok).toBe(false);
    const second = await submitWork(s.project, s.ann.id, { labels: ['positive'] });
    await recordReview(second.id, s.reviewer.id, {
      decision: 'APPROVE',
      qaScore: 5,
      feedback: '',
    });
    const told = await mine(s.ann.id);
    expect(told.map((n) => [n.kind, n.link])).toEqual([
      ['review.sent_back', `/my-work/${first.id}`],
    ]);
    expect(told[0].detail).not.toHaveProperty('feedback');
  });

  it('tells the managers about a new dispute, and both sides about its outcome', async () => {
    const s = await setup();
    const work = await submitWork(s.project, s.ann.id, { labels: ['positive'] });
    await recordReview(work.id, s.reviewer.id, {
      decision: 'SEND_BACK',
      qaScore: 2,
      feedback: 'No.',
    });
    const opened = await openDispute(work.id, s.ann.id, 'It is positive.');
    if (!opened.ok) throw new Error(opened.error);
    // managers only; the reviewers see the Disputes tab count
    expect((await mine(s.pm.id)).map((n) => n.kind)).toEqual(['dispute.opened']);
    expect((await mine(s.admin.id)).map((n) => n.kind)).toEqual(['dispute.opened']);
    expect(await prisma.notification.count({ where: { userId: s.reviewer.id } })).toBe(0);

    await resolveDispute(opened.dispute.id, s.pm.id, {
      outcome: 'OVERTURNED',
      resolution: 'Agreed.',
    });
    expect((await mine(s.ann.id)).map((n) => n.kind)).toEqual([
      'review.sent_back',
      'dispute.resolved',
    ]);
    const toReviewer = await mine(s.reviewer.id);
    expect(toReviewer.map((n) => [n.kind, (n.detail as { role: string }).role])).toEqual([
      ['dispute.resolved', 'reviewer'],
    ]);
    // the manager who settled it is not told about their own action
    expect((await mine(s.pm.id)).map((n) => n.kind)).toEqual(['dispute.opened']);
  });

  it('tells annotators of a rescore only where gold feedback already shows gold', async () => {
    for (const goldFeedback of [true, false]) {
      await resetDb();
      const s = await setup();
      const project = await prisma.project.update({
        where: { id: s.project.id },
        data: { goldFeedback, reviewRequired: false },
      });
      await prisma.task.updateMany({
        where: { projectId: project.id },
        data: { isGold: true, goldAnswer: { labels: ['positive'] } },
      });
      const work = await submitWork(project, s.ann.id, { labels: ['negative'] });
      await prisma.task.update({
        where: { id: work.taskId },
        data: { goldAnswer: { labels: ['negative'] } },
      });
      const plan = await previewRescore(project, work.taskId);
      const result = await applyRescore(project, work.taskId, s.pm.id, plan!.digest);
      expect(result.ok).toBe(true);
      const told = await mine(s.ann.id);
      if (goldFeedback) {
        expect(told.map((n) => n.kind)).toEqual(['gold.rescored']);
        expect(told[0].detail).toMatchObject({ from: 0, to: 1 });
      } else {
        expect(told).toEqual([]);
      }
    }
  });

  it('tells the annotator a manager released their claim, and members about new instructions', async () => {
    const s = await setup();
    const claim = await claimNextTask(s.project, s.ann.id);
    if (!claim.ok) throw new Error('no claim');
    await releaseClaim(s.project, claim.assignment.id, s.pm.id);
    expect((await mine(s.ann.id)).map((n) => [n.kind, n.link])).toEqual([
      ['claim.released', `/projects/${s.project.id}`],
    ]);

    const { updateProject } = await import('~/models/projects.server');
    const { parseProjectForm } = await import('~/domain/project-form');
    const form = new FormData();
    for (const [key, value] of Object.entries({
      name: 'Sentiment',
      description: '',
      instructions: 'Read every word.',
      overlap: '1',
      timeLimitMinutes: '30',
      reviewRequired: 'on',
      reviewSamplePercent: '100',
      disputeWindowDays: '14',
      qualificationPassPercent: '80',
      payMode: 'PER_TASK',
      rate: '0.10',
      schema: JSON.stringify(s.project.schema),
    })) {
      form.set(key, value);
    }
    const parsed = parseProjectForm(form);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    await updateProject(s.project.id, parsed.value, s.pm.id);
    // the members of the project, not the manager who changed them
    expect((await mine(s.ann.id)).map((n) => n.kind)).toContain('project.instructions');
    expect((await mine(s.reviewer.id)).map((n) => n.kind)).toEqual(['project.instructions']);
    expect(await prisma.notification.count({ where: { userId: s.pm.id } })).toBe(0);
  });

  it('counts unread ones in the header, and opening the page reads only one’s own', async () => {
    const s = await setup();
    const work = await submitWork(s.project, s.ann.id, { labels: ['positive'] });
    await recordReview(work.id, s.reviewer.id, {
      decision: 'SEND_BACK',
      qaScore: 2,
      feedback: 'No.',
    });
    await prisma.notification.create({
      data: { userId: s.reviewer.id, orgId: s.org.id, kind: 'review.fixed', link: '/' },
    });
    const annCookie = await cookieFor(s.ann, s.org.id);
    const header = await run(layoutLoader, makeRequest('/', { cookie: annCookie }));
    expect(payload<{ unread: number }>(header).unread).toBe(1);

    const page = await run(
      notificationsLoader,
      makeRequest('/notifications', { cookie: annCookie }),
    );
    const shown = payload<{ notifications: Array<{ isNew: boolean; text: string }> }>(page);
    expect(shown.notifications).toHaveLength(1);
    expect(shown.notifications[0]).toMatchObject({ isNew: true });
    expect(shown.notifications[0].text).toContain('sent back your work on task #');
    const after = await run(layoutLoader, makeRequest('/', { cookie: annCookie }));
    expect(payload<{ unread: number }>(after).unread).toBe(0);
    // the reviewer's own notification is untouched
    expect(
      await prisma.notification.count({ where: { userId: s.reviewer.id, readAt: null } }),
    ).toBe(1);
  });

  it('keeps each organisation’s notifications apart and removes old read ones', async () => {
    const s = await setup();
    const other = await createOrg('Other');
    await prisma.membership.create({
      data: { orgId: other.id, userId: s.ann.id, role: 'ANNOTATOR' },
    });
    const now = new Date();
    const old = new Date(now.getTime() - 100 * 24 * 3600_000);
    await prisma.notification.createMany({
      data: [
        { userId: s.ann.id, orgId: other.id, kind: 'review.fixed', link: '/' },
        { userId: s.ann.id, orgId: s.org.id, kind: 'review.fixed', link: '/', createdAt: old },
        {
          userId: s.ann.id,
          orgId: s.org.id,
          kind: 'review.fixed',
          link: '/',
          createdAt: old,
          readAt: old,
        },
      ],
    });
    const shown = await openNotifications(s.ann.id, s.org.id, now);
    // the other organisation's is not shown here; the old read one is gone,
    // the old unread one stays until it has been seen
    expect(shown).toHaveLength(1);
    expect(await prisma.notification.count({ where: { userId: s.ann.id } })).toBe(2);
    expect(await prisma.notification.count({ where: { orgId: other.id, readAt: null } })).toBe(1);
  });
});
