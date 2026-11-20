import { beforeEach, describe, expect, it } from 'vitest';

import { SCHEMA_TEMPLATES } from '~/domain/task-schema';
import { loader as activityLoader } from '~/routes/project-activity';
import { action as newProjectAction } from '~/routes/project-new';
import { loader as overviewLoader } from '~/routes/project-overview';
import { action as settingsAction } from '~/routes/project-settings';
import { loader as projectsLoader } from '~/routes/projects';

import {
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

const validForm = {
  name: 'Support ticket triage',
  description: 'Route tickets to teams',
  instructions: '# Guide',
  schema: JSON.stringify(SCHEMA_TEMPLATES.text_classification),
  overlap: '2',
  timeLimitMinutes: '20',
  reviewRequired: 'on',
};

describe('projects', () => {
  beforeEach(resetDb);

  it('lets a project manager create a project', async () => {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const cookie = await cookieFor(pm, org.id);

    const result = await run(
      newProjectAction,
      makeRequest('/projects/new', { cookie, form: validForm }),
    );

    const project = await prisma.project.findFirstOrThrow();
    expect(locationOf(result)).toBe(`/projects/${project.id}`);
    expect(project).toMatchObject({
      orgId: org.id,
      kind: 'TEXT_CLASSIFICATION',
      status: 'DRAFT',
      overlap: 2,
      timeLimitMinutes: 20,
      reviewRequired: true,
      reviewSamplePercent: 100,
      disputeWindowDays: 14,
    });
  });

  it('stores the share of work to review and copies it to a duplicate', async () => {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const cookie = await cookieFor(pm, org.id);

    await run(
      newProjectAction,
      makeRequest('/projects/new', { cookie, form: { ...validForm, reviewSamplePercent: '25' } }),
    );
    const project = await prisma.project.findFirstOrThrow();
    expect(project.reviewSamplePercent).toBe(25);
    const overview = await run(overviewLoader, makeRequest(`/projects/${project.id}`, { cookie }), {
      projectId: project.id,
    });
    expect(payload<{ project: { review: string } }>(overview).project.review).toBe('25% sample');

    const path = `/projects/${project.id}/settings`;
    const params = { projectId: project.id };
    const edited = { ...validForm, reviewSamplePercent: '40', disputeWindowDays: '7' };
    await run(settingsAction, makeRequest(path, { cookie, form: edited }), params);
    await run(settingsAction, makeRequest(path, { cookie, form: { intent: 'duplicate' } }), params);
    const copies = await prisma.project.findMany({
      select: { reviewSamplePercent: true, disputeWindowDays: true },
    });
    expect(copies).toEqual([
      { reviewSamplePercent: 40, disputeWindowDays: 7 },
      { reviewSamplePercent: 40, disputeWindowDays: 7 },
    ]);
  });

  it('saves the review share in the same save as a schema edit, or not at all', async () => {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const cookie = await cookieFor(pm, org.id);
    const project = await createTestProject(org.id);
    await createTasks(project.id, [{ text: 'x' }]);
    const ann = await createMember(org.id, 'ANNOTATOR');
    await submitWork(project, ann.id, { labels: ['positive'] });
    const path = `/projects/${project.id}/settings`;
    const params = { projectId: project.id };
    const schemaWith = (labels: string[]) => ({
      kind: 'text_classification',
      textField: 'text',
      labels,
      multiple: false,
    });
    const save = (labels: string[], reviewSamplePercent: string) =>
      run(
        settingsAction,
        makeRequest(path, {
          cookie,
          form: { ...validForm, schema: JSON.stringify(schemaWith(labels)), reviewSamplePercent },
        }),
        params,
      );
    const saved = () => prisma.project.findUniqueOrThrow({ where: { id: project.id } });

    // an allowed edit: the check against stored work and the write are one transaction
    const added = await save(['positive', 'negative', 'neutral'], '30');
    expect(payload<{ saved: boolean }>(added).saved).toBe(true);
    expect(await saved()).toMatchObject({
      reviewSamplePercent: 30,
      schema: schemaWith(['positive', 'negative', 'neutral']),
    });

    // a refused edit saves nothing of the form, the share included
    const refused = await save(['negative', 'neutral'], '5');
    expect(statusOf(refused)).toBe(400);
    expect(await saved()).toMatchObject({
      reviewSamplePercent: 30,
      schema: schemaWith(['positive', 'negative', 'neutral']),
    });
  });

  it('returns field errors for an invalid schema', async () => {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const cookie = await cookieFor(pm, org.id);

    const result = await run(
      newProjectAction,
      makeRequest('/projects/new', { cookie, form: { ...validForm, schema: '{"kind":"x"}' } }),
    );

    expect(statusOf(result)).toBe(400);
    expect(payload<{ errors: Record<string, string> }>(result).errors.schema).toBeTruthy();
    expect(await prisma.project.count()).toBe(0);
  });

  it('does not let annotators create projects', async () => {
    const org = await createOrg();
    const annotator = await createMember(org.id, 'ANNOTATOR');
    const cookie = await cookieFor(annotator, org.id);

    const result = await run(
      newProjectAction,
      makeRequest('/projects/new', { cookie, form: validForm }),
    );

    expect(statusOf(result)).toBe(403);
  });

  it('only lists projects an annotator is a member of', async () => {
    const org = await createOrg();
    const annotator = await createMember(org.id, 'ANNOTATOR');
    const mine = await createTestProject(org.id, { name: 'Mine' });
    await createTestProject(org.id, { name: 'Not mine' });
    await prisma.projectMember.create({ data: { projectId: mine.id, userId: annotator.id } });
    const cookie = await cookieFor(annotator, org.id);

    const result = await run(projectsLoader, makeRequest('/projects', { cookie }));

    const names = payload<{ projects: Array<{ name: string }> }>(result).projects.map(
      (p) => p.name,
    );
    expect(names).toEqual(['Mine']);
  });

  it('hides archived projects unless asked', async () => {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    await createTestProject(org.id, { name: 'Live' });
    await createTestProject(org.id, { name: 'Old', status: 'ARCHIVED' });
    const cookie = await cookieFor(pm, org.id);
    const names = async (path: string) =>
      payload<{ projects: Array<{ name: string }> }>(
        await run(projectsLoader, makeRequest(path, { cookie })),
      ).projects.map((p) => p.name);
    expect(await names('/projects')).toEqual(['Live']);
    expect((await names('/projects?archived=1')).sort()).toEqual(['Live', 'Old']);
  });

  it('hides projects from other organisations', async () => {
    const org = await createOrg('One');
    const other = await createOrg('Two');
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const foreign = await createTestProject(other.id);
    const cookie = await cookieFor(pm, org.id);

    const result = await run(overviewLoader, makeRequest(`/projects/${foreign.id}`, { cookie }), {
      projectId: foreign.id,
    });

    expect(statusOf(result)).toBe(404);
  });

  it('saves settings and moves a draft to active', async () => {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const project = await createTestProject(org.id, { status: 'DRAFT' });
    const cookie = await cookieFor(pm, org.id);
    const path = `/projects/${project.id}/settings`;

    const saved = await run(
      settingsAction,
      makeRequest(path, { cookie, form: { ...validForm, name: 'Renamed' } }),
      { projectId: project.id },
    );
    expect(payload<{ saved: boolean }>(saved).saved).toBe(true);

    await run(settingsAction, makeRequest(path, { cookie, form: { intent: 'activate' } }), {
      projectId: project.id,
    });

    const updated = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(updated.name).toBe('Renamed');
    expect(updated.status).toBe('ACTIVE');
  });

  it('records when the instructions change, and only then', async () => {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const project = await createTestProject(org.id, { instructions: '# Guide' });
    const cookie = await cookieFor(pm, org.id);
    const path = `/projects/${project.id}/settings`;
    const save = (instructions: string) =>
      run(settingsAction, makeRequest(path, { cookie, form: { ...validForm, instructions } }), {
        projectId: project.id,
      });

    await save('# Guide');
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).instructionsUpdatedAt,
    ).toBeNull();
    await save('# Guide\n\nNew rule: sarcasm counts as negative.');
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).instructionsUpdatedAt,
    ).not.toBeNull();
  });

  it('duplicates a project without its tasks', async () => {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const ann = await createMember(org.id, 'ANNOTATOR');
    const project = await createTestProject(org.id, { name: 'Original', instructions: '# Rules' });
    await prisma.projectMember.create({ data: { projectId: project.id, userId: ann.id } });
    await prisma.batch.create({ data: { projectId: project.id, name: 'b', format: 'CSV' } });

    const result = await run(
      settingsAction,
      makeRequest(`/projects/${project.id}/settings`, {
        cookie: await cookieFor(pm, org.id),
        form: { intent: 'duplicate' },
      }),
      { projectId: project.id },
    );

    const copy = await prisma.project.findFirstOrThrow({
      where: { name: 'Original (copy)' },
      include: { members: true, batches: true },
    });
    expect(locationOf(result)).toBe(`/projects/${copy.id}/settings`);
    expect(copy).toMatchObject({
      status: 'DRAFT',
      instructions: '# Rules',
      kind: 'TEXT_CLASSIFICATION',
    });
    expect(copy.members.map((m) => m.userId)).toEqual([ann.id]);
    expect(copy.batches).toEqual([]);
  });

  it('lists what managers did on the activity tab', async () => {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER', { name: 'Pat' });
    const project = await createTestProject(org.id, { status: 'DRAFT' });
    const cookie = await cookieFor(pm, org.id);
    await run(
      settingsAction,
      makeRequest(`/projects/${project.id}/settings`, { cookie, form: { intent: 'activate' } }),
      { projectId: project.id },
    );
    const result = await run(
      activityLoader,
      makeRequest(`/projects/${project.id}/activity`, { cookie }),
      {
        projectId: project.id,
      },
    );
    expect(payload<{ entries: Array<{ actor: string; text: string }> }>(result).entries).toEqual([
      expect.objectContaining({ actor: 'Pat', text: 'changed the status from draft to active' }),
    ]);
  });

  it('refuses to pause a draft project', async () => {
    const org = await createOrg();
    const pm = await createMember(org.id, 'ADMIN');
    const project = await createTestProject(org.id, { status: 'DRAFT' });
    const cookie = await cookieFor(pm, org.id);

    const result = await run(
      settingsAction,
      makeRequest(`/projects/${project.id}/settings`, { cookie, form: { intent: 'pause' } }),
      { projectId: project.id },
    );

    expect(statusOf(result)).toBe(400);
  });
});
