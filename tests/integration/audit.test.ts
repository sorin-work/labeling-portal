import { beforeEach, describe, expect, it } from 'vitest';

import { logActivity } from '~/models/activity.server';
import { openDispute, resolveDispute } from '~/models/disputes.server';
import { changeRole } from '~/models/people.server';
import { recordReview } from '~/models/reviews.server';
import { action as accountAction } from '~/routes/account';
import { loader as auditExportLoader } from '~/routes/audit-export';
import { loader as auditLoader } from '~/routes/audit';
import { action as loginAction } from '~/routes/login';
import { loader as payoutsExportLoader } from '~/routes/payouts-export';
import { action as peopleAction } from '~/routes/people';
import { loader as activityLoader } from '~/routes/project-activity';
import { loader as downloadLoader } from '~/routes/project-download';
import { action as membersAction } from '~/routes/project-members';
import { loader as qualityExportLoader } from '~/routes/project-quality-export';

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

type Entry = { actor: string; action: string; text: string; project: string | null };
type Audit = { entries: Entry[]; page: { total: number; pageCount: number; page: number } };

async function setup() {
  const org = await createOrg();
  const admin = await createMember(org.id, 'ADMIN', { name: 'Ada' });
  const project = await createTestProject(org.id, { name: 'Sentiment' });
  return { org, admin, project, cookie: await cookieFor(admin, org.id) };
}

const audit = async (cookie: string, query = '') =>
  payload<Audit>(await run(auditLoader, makeRequest(`/audit${query}`, { cookie })));

const actions = async (orgId: string) =>
  (await prisma.activity.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })).map(
    (a) => a.action,
  );

describe('the audit page', () => {
  beforeEach(resetDb);

  it('is for admins only, the page and the CSV alike', async () => {
    const { org } = await setup();
    for (const role of ['PROJECT_MANAGER', 'REVIEWER', 'ANNOTATOR'] as const) {
      const someone = await createMember(org.id, role);
      const cookie = await cookieFor(someone, org.id);
      expect(statusOf(await run(auditLoader, makeRequest('/audit', { cookie }))), role).toBe(403);
      expect(
        statusOf(await run(auditExportLoader, makeRequest('/audit/export', { cookie }))),
        role,
      ).toBe(403);
    }
  });

  it('shows only the entries of the admin’s own organisation', async () => {
    const { org, admin, cookie } = await setup();
    const other = await createOrg('Other');
    const stranger = await createMember(other.id, 'ADMIN', { name: 'Stranger' });
    const theirs = await createTestProject(other.id, { name: 'Theirs' });
    await logActivity(prisma, { orgId: org.id, actorId: admin.id, action: 'auth.signed_in' });
    await logActivity(prisma, {
      projectId: theirs.id,
      actorId: stranger.id,
      action: 'project.status',
      detail: { from: 'DRAFT', to: 'ACTIVE' },
    });
    // a filter that names the other organisation's project finds nothing either
    expect((await audit(cookie)).entries.map((e) => e.actor)).toEqual(['Ada']);
    expect((await audit(cookie, `?project=${theirs.id}`)).entries).toEqual([]);
    expect((await audit(cookie, `?person=${stranger.id}`)).entries).toEqual([]);
  });

  it('filters by person, action, project and day, in pages', async () => {
    const { org, admin, project, cookie } = await setup();
    const pat = await createMember(org.id, 'PROJECT_MANAGER', { name: 'Pat' });
    for (let i = 0; i < 30; i++) {
      await logActivity(prisma, {
        projectId: project.id,
        actorId: pat.id,
        action: 'batch.priority',
        detail: { name: `b${i}`, from: i, to: i + 1 },
        createdAt: new Date(`2026-03-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`),
      });
    }
    await logActivity(prisma, {
      orgId: org.id,
      actorId: admin.id,
      action: 'auth.signed_in',
      createdAt: new Date('2026-03-05T12:00:00Z'),
    });

    const all = await audit(cookie);
    expect(all.page).toMatchObject({ total: 31, pageCount: 2, page: 1 });
    expect(all.entries).toHaveLength(25);
    expect((await audit(cookie, '?page=2')).entries).toHaveLength(6);

    expect((await audit(cookie, `?person=${admin.id}`)).entries.map((e) => e.action)).toEqual([
      'auth.signed_in',
    ]);
    expect((await audit(cookie, '?action=auth.signed_in')).page.total).toBe(1);
    // an action that does not exist is no filter at all
    expect((await audit(cookie, '?action=nonsense')).page.total).toBe(31);
    expect((await audit(cookie, `?project=${project.id}`)).page.total).toBe(30);
    // both days included
    const days = await audit(cookie, '?from=2026-03-05&to=2026-03-06');
    expect(days.entries.map((e) => e.action).sort()).toEqual([
      'auth.signed_in',
      'batch.priority',
      'batch.priority',
    ]);
    expect(days.entries.find((e) => e.action === 'batch.priority')).toMatchObject({
      actor: 'Pat',
      project: 'Sentiment',
      text: 'set the priority of “b5” to 6 (it was 5)',
    });
  });

  it('downloads the filtered entries as CSV, oldest first and safe for spreadsheets', async () => {
    const { org, project, cookie } = await setup();
    const sly = await createMember(org.id, 'PROJECT_MANAGER', { name: '=HYPERLINK("x")' });
    await logActivity(prisma, {
      projectId: project.id,
      actorId: sly.id,
      action: 'project.status',
      detail: { from: 'DRAFT', to: 'ACTIVE' },
      createdAt: new Date('2026-03-01T10:00:00Z'),
    });
    await logActivity(prisma, {
      projectId: project.id,
      actorId: sly.id,
      action: 'project.status',
      detail: { from: 'ACTIVE', to: 'PAUSED' },
      createdAt: new Date('2026-03-02T10:00:00Z'),
    });
    await logActivity(prisma, { orgId: org.id, actorId: sly.id, action: 'auth.signed_in' });

    const response = (await run(
      auditExportLoader,
      makeRequest('/audit/export?action=project.status', { cookie }),
    )) as Response;
    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    const lines = (await response.text()).trimEnd().split('\r\n');
    expect(lines[0]).toBe('created_at,actor,actor_id,action,project,project_id,description,detail');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^2026-03-01T10:00:00.000Z,"'=HYPERLINK\(""x""\)",/);
    expect(lines[1]).toContain('changed the status from draft to active');
    expect(lines[2]).toContain('active to paused');
  });
});

describe('entries are only ever added', () => {
  beforeEach(resetDb);

  it('cannot be changed or removed, and outlive the account and the project', async () => {
    const { org, project } = await setup();
    const pat = await createMember(org.id, 'PROJECT_MANAGER', { name: 'Pat' });
    const entry = await logActivity(prisma, {
      projectId: project.id,
      actorId: pat.id,
      action: 'project.status',
      detail: { from: 'DRAFT', to: 'ACTIVE' },
    });
    await expect(
      prisma.activity.update({ where: { id: entry.id }, data: { detail: { from: 'X' } } }),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      prisma.activity.update({ where: { id: entry.id }, data: { actorName: 'Someone else' } }),
    ).rejects.toThrow(/cannot be changed/);
    await expect(prisma.activity.delete({ where: { id: entry.id } })).rejects.toThrow(
      /cannot be removed/,
    );
    await expect(prisma.$executeRaw`DELETE FROM "Activity"`).rejects.toThrow(/cannot be removed/);
    // clearing a link is what a deleted account or project does, and only that may do it
    await expect(
      prisma.activity.updateMany({ where: { id: entry.id }, data: { projectId: null } }),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      prisma.activity.updateMany({ where: { id: entry.id }, data: { actorId: null } }),
    ).rejects.toThrow(/cannot be changed/);
    await expect(prisma.$executeRaw`TRUNCATE "Activity"`).rejects.toThrow(/cannot be removed/);
    await expect(prisma.$executeRaw`TRUNCATE "Organization" CASCADE`).rejects.toThrow(
      /cannot be removed/,
    );

    await prisma.user.delete({ where: { id: pat.id } });
    await prisma.project.delete({ where: { id: project.id } });
    expect(await prisma.activity.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({
      actorId: null,
      projectId: null,
      actorName: 'Pat',
      action: 'project.status',
    });
  });

  it('go with their organisation', async () => {
    const { org, admin } = await setup();
    await logActivity(prisma, { orgId: org.id, actorId: admin.id, action: 'auth.signed_in' });
    await prisma.organization.delete({ where: { id: org.id } });
    expect(await prisma.activity.count()).toBe(0);
  });

  it('are written with the change, so a change without its entry is not kept', async () => {
    const { org } = await setup();
    const dana = await createMember(org.id, 'REVIEWER');
    // an actor that does not exist: the entry cannot be written, and the role stays
    await expect(changeRole(org.id, 'nobody', dana.id, 'ADMIN')).rejects.toThrow();
    expect(
      await prisma.membership.findUniqueOrThrow({
        where: { orgId_userId: { orgId: org.id, userId: dana.id } },
      }),
    ).toMatchObject({ role: 'REVIEWER' });
    expect(await prisma.activity.count()).toBe(0);
  });
});

describe('what is recorded', () => {
  beforeEach(resetDb);

  it('records the people events, with no password in them', async () => {
    const { org, cookie } = await setup();
    const post = (form: Record<string, string>) =>
      run(peopleAction, makeRequest('/people', { cookie, form }));
    await post({
      intent: 'add',
      name: 'Dana',
      email: 'dana@example.test',
      role: 'REVIEWER',
      password: 'first-secret-1',
    });
    const dana = await prisma.user.findUniqueOrThrow({ where: { email: 'dana@example.test' } });
    // adding someone who is already there changes nothing and records nothing
    await post({
      intent: 'add',
      name: 'Dana',
      email: 'dana@example.test',
      role: 'REVIEWER',
      password: 'first-secret-1',
    });
    await post({ intent: 'role', userId: dana.id, role: 'PROJECT_MANAGER' });
    await post({ intent: 'role', userId: dana.id, role: 'PROJECT_MANAGER' });
    await post({ intent: 'password', userId: dana.id, password: 'second-secret-2' });
    await post({ intent: 'remove', userId: dana.id });

    const changed = await run(
      accountAction,
      makeRequest('/account', {
        cookie,
        form: { current: 'password123', next: 'third-secret-3', confirm: 'third-secret-3' },
      }),
    );
    // the password change ended the old cookie; the tab that made it got a new one
    const renewed = (changed as { init: { headers: Record<string, string> } }).init.headers[
      'Set-Cookie'
    ].split(';')[0];

    expect(await actions(org.id)).toEqual([
      'person.added',
      'person.role',
      'person.password',
      'person.removed',
      'account.password',
    ]);
    const stored = JSON.stringify(await prisma.activity.findMany());
    for (const secret of ['first-secret-1', 'second-secret-2', 'third-secret-3', 'password123']) {
      expect(stored).not.toContain(secret);
    }
    const passwordHash = (await prisma.user.findUniqueOrThrow({ where: { id: dana.id } }))
      .passwordHash;
    expect(stored).not.toContain(passwordHash);
    expect((await audit(renewed)).entries.map((e) => e.text)).toEqual([
      'changed their own password',
      'removed Dana from the organisation',
      'set a new password for Dana',
      'changed the role of Dana from reviewer to project manager',
      'added Dana as reviewer',
    ]);
  });

  it('records a sign-in, and a lockout only for an account that exists', async () => {
    const { org } = await setup();
    await createMember(org.id, 'ANNOTATOR', {
      email: 'ann-audit@example.test',
      password: 'secret-pass',
    });
    const signIn = (email: string, password: string) =>
      run(loginAction, makeRequest('/login', { form: { email, password } }));
    expect(statusOf(await signIn('ann-audit@example.test', 'secret-pass'))).toBe(302);

    for (let i = 0; i < 12; i++) await signIn('ann-audit@example.test', 'wrong');
    for (let i = 0; i < 12; i++) await signIn('nobody-audit@example.test', 'wrong');
    expect(await actions(org.id)).toEqual(['auth.signed_in', 'auth.locked']);
    expect(await prisma.activity.count()).toBe(2);
  });

  it('records members, a qualification reset and a project created', async () => {
    const { org, project, cookie } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
    const post = (intent: string) =>
      run(
        membersAction,
        makeRequest(`/projects/${project.id}/members`, {
          cookie,
          form: { intent, userId: ann.id },
        }),
        { projectId: project.id },
      );
    await post('add');
    // already on the project: no second entry
    await post('add');
    await prisma.projectMember.updateMany({
      where: { projectId: project.id, userId: ann.id },
      data: { qualifiedAt: new Date() },
    });
    await post('reset-qualification');
    await post('remove');
    await post('remove');

    const tab = payload<{ entries: Array<{ text: string }> }>(
      await run(activityLoader, makeRequest(`/projects/${project.id}/activity`, { cookie }), {
        projectId: project.id,
      }),
    );
    expect(tab.entries.map((e) => e.text)).toEqual([
      'removed Ann from the project',
      'reset the qualification of Ann, removing 0 attempts',
      'added Ann to the project',
    ]);
  });

  it('records the three downloads', async () => {
    const { project, cookie } = await setup();
    await createTasks(project.id, [{ text: 'a' }]);
    const labels = (await run(
      downloadLoader,
      makeRequest(`/projects/${project.id}/download?format=csv&annotators=email`, { cookie }),
      { projectId: project.id },
    )) as Response;
    await labels.text();
    await run(qualityExportLoader, makeRequest(`/projects/${project.id}/quality.csv`, { cookie }), {
      projectId: project.id,
    });
    await run(
      payoutsExportLoader,
      makeRequest(`/payouts/export?from=2026-03-01&to=2026-03-31&project=${project.id}`, {
        cookie,
      }),
    );
    expect((await audit(cookie)).entries.map((e) => [e.text, e.project])).toEqual([
      ['downloaded the pay report for 2026-03-01 to 2026-03-31 “Sentiment”', 'Sentiment'],
      ['downloaded the quality table “Sentiment”', 'Sentiment'],
      ['downloaded the labels “Sentiment” as csv, with email addresses', 'Sentiment'],
    ]);
  });

  it('records review decisions and settled disputes without feedback or answers', async () => {
    const { org, project, cookie } = await setup();
    await prisma.project.update({ where: { id: project.id }, data: { reviewRequired: true } });
    await createTasks(project.id, [{ text: 'a' }]);
    const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
    const rev = await createMember(org.id, 'REVIEWER', { name: 'Rev' });
    const pm = await createMember(org.id, 'PROJECT_MANAGER', { name: 'Pat' });
    const work = await submitWork(project, ann.id, { labels: ['positive'] });
    const reviewed = await recordReview(work.id, rev.id, {
      decision: 'SEND_BACK',
      qaScore: 2,
      feedback: 'private feedback words',
    });
    if (!reviewed.ok) throw new Error(reviewed.error);
    const opened = await openDispute(work.id, ann.id, 'My reason here.');
    if (!opened.ok) throw new Error(opened.error);
    expect(
      await resolveDispute(opened.dispute.id, pm.id, {
        outcome: 'OVERTURNED',
        resolution: 'Resolution words.',
      }),
    ).toEqual({ ok: true });

    const texts = (await audit(cookie)).entries.map((e) => `${e.actor} ${e.text}`);
    expect(texts).toEqual([
      'Pat overturned a review of the work of Ann on task #1 after a dispute',
      'Rev sent back the work of Ann on task #1 (QA 2)',
    ]);
    const stored = JSON.stringify(await prisma.activity.findMany());
    for (const words of [
      'private feedback words',
      'My reason here.',
      'Resolution words.',
      'positive',
    ]) {
      expect(stored).not.toContain(words);
    }
  });
});
