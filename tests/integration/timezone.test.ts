import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Everything in this file talks to the database through sessions whose time
// zone is not UTC. Dates passed to raw SQL must come out the same anyway.
const ZONE = 'Europe/Bucharest';
const original = vi.hoisted(() => {
  const url = process.env.DATABASE_URL ?? '';
  process.env.DATABASE_URL = `${url}${url.includes('?') ? '&' : '?'}options=-c%20TimeZone%3DEurope%2FBucharest`;
  // the client is cached per process; this file needs one of its own
  globalThis.__prisma = undefined;
  return url;
});

import { dailyThroughput } from '~/models/quality.server';
import { claimNextTask, countAvailable } from '~/models/queue.server';
import { reserveNextReview } from '~/models/reviews.server';

import {
  createMember,
  createOrg,
  createTasks,
  createTestProject,
  prisma,
  resetDb,
  submitWork,
} from './helpers';

describe('a database session that is not in UTC', () => {
  beforeEach(resetDb);

  afterAll(async () => {
    await prisma.$disconnect();
    globalThis.__prisma = undefined;
    process.env.DATABASE_URL = original;
  });

  it('really is in another time zone here', async () => {
    const [row] = await prisma.$queryRaw<Array<{ TimeZone: string }>>`SHOW TimeZone`;
    expect(row.TimeZone).toBe(ZONE);
  });

  it('keeps a task with a live claim away from a second annotator', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 1 });
    await createTasks(project.id, [{ text: 'only one' }]);
    const first = await createMember(org.id, 'ANNOTATOR');
    const second = await createMember(org.id, 'ANNOTATOR');
    const t0 = new Date('2026-07-01T10:00:00Z');
    const soon = new Date(t0.getTime() + 60_000);

    expect((await claimNextTask(project, first.id, t0)).ok).toBe(true);

    expect(await claimNextTask(project, second.id, soon)).toEqual({ ok: false, reason: 'empty' });
    expect((await countAvailable([project.id], second.id, soon)).get(project.id) ?? 0).toBe(0);
    // once the limit has passed the task is free again
    const later = new Date(t0.getTime() + 31 * 60_000);
    expect((await claimNextTask(project, second.id, later)).ok).toBe(true);
  });

  it('counts a midday submission on its own UTC day', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { reviewRequired: false });
    await createTasks(project.id, [{ text: 'noon' }, { text: 'late' }]);
    const ann = await createMember(org.id, 'ANNOTATOR');
    // submitted five minutes after the claim: 12:00 and 23:30 UTC on 10 March
    await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-10T11:55:00Z') },
    );
    await submitWork(
      project,
      ann.id,
      { labels: ['positive'] },
      { now: new Date('2026-03-10T23:25:00Z') },
    );

    const days = await dailyThroughput(project.id, 3, new Date('2026-03-11T08:00:00Z'));

    expect(days).toEqual([
      { day: '2026-03-09', submitted: 0, accepted: 0 },
      { day: '2026-03-10', submitted: 2, accepted: 2 },
      { day: '2026-03-11', submitted: 0, accepted: 0 },
    ]);
  });

  it('stores a reviewer hold at the moment it was taken', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id);
    await createTasks(project.id, [{ text: 'one' }]);
    const ann = await createMember(org.id, 'ANNOTATOR');
    const reviewer = await createMember(org.id, 'REVIEWER');
    const other = await createMember(org.id, 'REVIEWER');
    const submission = await submitWork(project, ann.id, { labels: ['positive'] });
    const t0 = new Date('2026-07-01T10:00:00Z');

    expect(await reserveNextReview(project.id, reviewer.id, t0)).toEqual({ id: submission.id });

    const held = await prisma.assignment.findUniqueOrThrow({ where: { id: submission.id } });
    expect(held.reviewHeldAt).toEqual(t0);
    const tooEarly = new Date(t0.getTime() + 14 * 60_000);
    expect(await reserveNextReview(project.id, other.id, tooEarly)).toBeNull();
  });
});
