import { beforeEach, describe, expect, it } from 'vitest';

import { backupStatus, needsAttention } from '~/models/attention.server';
import { loader as dashboardLoader } from '~/routes/dashboard';

import {
  cookieFor,
  createMember,
  createOrg,
  createTestProject,
  makeRequest,
  payload,
  prisma,
  resetDb,
  run,
  submitWork,
} from './helpers';

const HOUR = 3_600_000;
const DAY_SECONDS = 86_400;

/** A row as docker/backup.sh writes it, `hoursAgo` before `now`. */
function backupRun(now: Date, hoursAgo: number, ok: boolean, message: string | null = null) {
  const finishedAt = new Date(now.getTime() - hoursAgo * HOUR);
  return prisma.backupRun.create({
    data: {
      startedAt: new Date(finishedAt.getTime() - 5000),
      finishedAt,
      ok,
      file: ok ? `labeling-${hoursAgo}.dump` : null,
      bytes: ok ? 1234n : null,
      message,
      intervalSeconds: DAY_SECONDS,
    },
  });
}

describe('needs attention', () => {
  beforeEach(resetDb);

  it('lists old pending reviews and annotators failing gold tasks', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { name: 'Sentiment' });
    const batch = await prisma.batch.create({
      data: { projectId: project.id, name: 'b', format: 'CSV' },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.task.create({
        data: {
          projectId: project.id,
          batchId: batch.id,
          position: i + 1,
          data: { text: `gold ${i}` },
          isGold: true,
          goldAnswer: { labels: ['positive'] },
        },
      });
    }
    await prisma.task.create({
      data: { projectId: project.id, batchId: batch.id, position: 9, data: { text: 'x' } },
    });
    const sloppy = await createMember(org.id, 'ANNOTATOR', { name: 'Sloppy' });
    for (let i = 0; i < 3; i++) await submitWork(project, sloppy.id, { labels: ['negative'] });
    await submitWork(
      project,
      sloppy.id,
      { labels: ['negative'] },
      { now: new Date(Date.now() - 3 * 86_400_000) },
    );

    const items = await needsAttention(org.id);
    expect(items).toEqual(
      expect.arrayContaining([
        { kind: 'stale-reviews', projectId: project.id, projectName: 'Sentiment', count: 1 },
        expect.objectContaining({ kind: 'low-gold', userName: 'Sloppy', accuracy: 0, attempts: 3 }),
      ]),
    );
  });

  it('is empty for a quiet organisation', async () => {
    const org = await createOrg();
    await createTestProject(org.id);
    expect(await needsAttention(org.id)).toEqual([]);
  });

  describe('backups', () => {
    const now = new Date('2026-11-21T12:00:00Z');

    it('says nothing before the backup service has written a row', async () => {
      expect(await backupStatus(now)).toBeNull();
    });

    it('names a failed dump, and the good one before it, which is not late yet', async () => {
      await backupRun(now, 30, true);
      await backupRun(now, 2, false, 'pg_dump: error: connection to server failed');
      expect(await backupStatus(now)).toEqual({
        items: [
          {
            kind: 'backup-failed',
            at: new Date(now.getTime() - 2 * HOUR),
            message: 'pg_dump: error: connection to server failed',
          },
        ],
        lastGood: { file: 'labeling-30.dump', finishedAt: new Date(now.getTime() - 30 * HOUR) },
      });
    });

    it('says how long there has been no good dump, after one and a half intervals', async () => {
      await backupRun(now, 40, true);
      expect((await backupStatus(now))?.items).toEqual([
        { kind: 'backup-late', hours: 40, lastGoodAt: new Date(now.getTime() - 40 * HOUR) },
      ]);
      await backupRun(now, 1, true);
      expect((await backupStatus(now))?.items).toEqual([]);
    });

    it('goes by the order rows were written in, so a row from a fast clock hides nothing', async () => {
      // the container's clock ran a week ahead for one dump
      await backupRun(now, -7 * 24, true);
      await backupRun(now, 2, false, 'pg_dump: error: one');
      await backupRun(now, 1, false, 'pg_dump: error: two');
      expect((await backupStatus(now))?.items).toEqual([
        {
          kind: 'backup-failed',
          at: new Date(now.getTime() - HOUR),
          message: 'pg_dump: error: two',
        },
      ]);
      // once the real clock has passed its date it ages like any other
      expect((await backupStatus(new Date(now.getTime() + 9 * 24 * HOUR)))?.items).toEqual([
        expect.objectContaining({ kind: 'backup-failed' }),
        expect.objectContaining({ kind: 'backup-late', hours: 48 }),
      ]);
    });

    it('says when no dump has worked at all', async () => {
      await backupRun(now, 1, false);
      expect((await backupStatus(now))?.items).toEqual([
        { kind: 'backup-failed', at: new Date(now.getTime() - HOUR), message: null },
        { kind: 'backup-late', hours: null, lastGoodAt: null },
      ]);
    });

    it('is on the dashboard of admins only', async () => {
      const org = await createOrg();
      const admin = await createMember(org.id, 'ADMIN');
      const pm = await createMember(org.id, 'PROJECT_MANAGER');
      await backupRun(new Date(), 50, true);
      type Page = { attention: Array<{ kind: string }>; lastBackup: { file: string } | null };
      const forAdmin = payload<Page>(
        await run(dashboardLoader, makeRequest('/', { cookie: await cookieFor(admin, org.id) })),
      );
      expect(forAdmin.attention.map((i) => i.kind)).toEqual(['backup-late']);
      expect(forAdmin.lastBackup?.file).toBe('labeling-50.dump');
      const forPm = payload<Page>(
        await run(dashboardLoader, makeRequest('/', { cookie: await cookieFor(pm, org.id) })),
      );
      expect(forPm.attention).toEqual([]);
      expect(forPm.lastBackup).toBeNull();
    });
  });
});
