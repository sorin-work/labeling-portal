import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { schemaUsage, schemaUsageSql } from '~/models/projects.server';
import { projectQuality } from '~/models/quality.server';
import {
  claimNextTask,
  countAvailable,
  nextTaskSql,
  queueSecretFor,
  releaseAssignment,
  releaseExpiredClaims,
  skipAssignment,
  submitAssignment,
} from '~/models/queue.server';
import { recordReview } from '~/models/reviews.server';

import {
  addToProject,
  createMember,
  createOrg,
  createTasks,
  createTestProject,
  prisma,
  resetDb,
} from './helpers';
import { createLargeProject, type LargeFixture } from './large-fixture';

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Function Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
};

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

/** The plan of a statement as PostgreSQL ran it. */
async function plan(sql: Prisma.Sql): Promise<PlanNode[]> {
  const rows = await prisma.$transaction((tx) =>
    tx.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
      Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    ),
  );
  return nodes(rows[0]['QUERY PLAN'][0].Plan);
}

/** Rows a plan read from one table: returned plus filtered out, over every loop. */
function rowsRead(all: PlanNode[], relation: string): number {
  return all
    .filter((n) => n['Relation Name'] === relation)
    .reduce(
      (sum, n) => sum + (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0)) * n['Actual Loops'],
      0,
    );
}

/** A small PRNG so the random series is the same on every run. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

describe('the slot counter', () => {
  beforeEach(resetDb);

  it('matches a fresh count after a random series of claims, skips, releases, expiries and reviews', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 2, reviewRequired: true });
    const tasks = await createTasks(
      project.id,
      Array.from({ length: 12 }, (_, i) => ({ text: `item ${i}` })),
    );
    const people = [];
    for (let i = 0; i < 6; i++) people.push(await createMember(org.id, 'ANNOTATOR'));
    await addToProject(project.id, ...people);
    const reviewer = await createMember(org.id, 'REVIEWER');
    const random = seeded(17);
    let now = new Date(Date.now() - 24 * 3600_000);

    for (let step = 0; step < 300; step++) {
      now = new Date(now.getTime() + Math.floor(random() * 20) * 60_000);
      const user = people[Math.floor(random() * people.length)];
      const roll = random();
      if (roll < 0.1) {
        // the clock jumps past every time limit; expired claims are marked at the next claim
        now = new Date(now.getTime() + 2 * 3600_000);
        continue;
      }
      if (roll < 0.2) {
        const pending = await prisma.assignment.findFirst({
          where: { projectId: project.id, status: 'SUBMITTED', reviewStatus: 'PENDING' },
          orderBy: { submittedAt: 'asc' },
        });
        if (pending) {
          await recordReview(
            pending.id,
            reviewer.id,
            { decision: random() < 0.7 ? 'APPROVE' : 'SEND_BACK', qaScore: null, feedback: 'ok' },
            now,
          );
        }
        continue;
      }
      const claim = await claimNextTask(project, user.id, now);
      if (!claim.ok) continue;
      const what = random();
      const id = claim.assignment.id;
      if (what < 0.25) await skipAssignment(id, user.id, 'Other: test');
      else if (what < 0.45) await releaseAssignment(id, user.id);
      else if (what < 0.6)
        continue; // left open; it runs out or is handed back later
      else {
        await submitAssignment(
          id,
          user.id,
          { answer: { labels: ['positive'] }, activeSeconds: 1, reviewRequired: true },
          new Date(now.getTime() + 60_000),
        );
      }
    }
    await releaseExpiredClaims(project.id, new Date(now.getTime() + 24 * 3600_000));

    const counted = await prisma.$queryRaw<Array<{ id: string; taken: number; fresh: number }>>`
      SELECT t.id, t."takenSlots" AS taken,
             (SELECT count(*)::int FROM "Assignment" a
              WHERE a."taskId" = t.id AND a.status IN ('ACTIVE', 'SUBMITTED')) AS fresh
      FROM "Task" t WHERE t."projectId" = ${project.id}`;
    expect(counted).toHaveLength(tasks.length);
    for (const row of counted) expect(row.taken).toBe(row.fresh);
    // and the series did exercise the counter
    expect(counted.some((row) => row.taken > 0)).toBe(true);
  });

  it('counts a claim past its limit as free in the dashboard count and in the claim', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 1 });
    const [task] = await createTasks(project.id, [{ text: 'only one' }]);
    const [ann, ben] = [
      await createMember(org.id, 'ANNOTATOR'),
      await createMember(org.id, 'ANNOTATOR'),
    ];
    const t0 = new Date(Date.now() - 3600_000);
    expect((await claimNextTask(project, ann.id, t0)).ok).toBe(true);
    expect((await countAvailable([project.id], ben.id, t0)).get(project.id) ?? 0).toBe(0);
    // 31 minutes later the claim has run out, and nothing has marked it yet
    const later = new Date(t0.getTime() + 31 * 60_000);
    expect((await countAvailable([project.id], ben.id, later)).get(project.id)).toBe(1);
    const claim = await claimNextTask(project, ben.id, later);
    expect(claim.ok && claim.assignment.taskId).toBe(task.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).takenSlots).toBe(1);
  });
});

describe('a project with 20,000 tasks', () => {
  let fx: LargeFixture;

  beforeAll(async () => {
    await resetDb();
    fx = await createLargeProject(20_000);
  }, 120_000);
  afterAll(resetDb);

  it('claims past 8,000 tasks waiting for review without a query per task', async () => {
    // no gold in front, so the first candidates are the tasks waiting for review
    await prisma.task.updateMany({
      where: { projectId: fx.project.id, isGold: true },
      data: { goldRetiredAt: new Date() },
    });
    const secret = await prisma.$transaction((tx) => queueSecretFor(tx, fx.project.id));
    const userId = fx.users[0];
    const all = await plan(nextTaskSql({ project: fx.project, userId, now: new Date(), secret }));
    // before the counter, every one of those tasks counted its assignments:
    // about 16,000 assignment rows; now only the free candidates are checked
    expect(rowsRead(all, 'Assignment')).toBeLessThan(500);
    expect(all.some((n) => n['Node Type'] === 'Aggregate')).toBe(false);

    const claim = await claimNextTask(fx.project, userId);
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: claim.ok ? claim.assignment.taskId : '' },
    });
    expect(task.position).toBeGreaterThan(18_000);
    await prisma.task.updateMany({
      where: { projectId: fx.project.id, isGold: true },
      data: { goldRetiredAt: null },
    });
  });

  it('takes apart each different answer once when it counts what the schema uses', async () => {
    const all = await plan(schemaUsageSql(fx.project.id));
    const unnested = all
      .filter((n) => n['Function Name'] === 'jsonb_array_elements')
      .reduce((sum, n) => sum + n['Actual Loops'], 0);
    // a handful of different answers, against some 37,000 stored ones
    expect(unnested).toBeLessThan(100);

    const usage = await schemaUsage(fx.project.id);
    const submissions = await prisma.assignment.count({
      where: { projectId: fx.project.id, answer: { not: Prisma.DbNull } },
    });
    expect(usage.answers.submission).toBe(submissions);
    expect(usage.tasks).toBe(20_000);
    const positive = usage.names.get('positive');
    const negative = usage.names.get('negative');
    expect((positive?.submission ?? 0) + (negative?.submission ?? 0)).toBe(submissions);
  });

  it('reads the quality page in two statements, not per relation', async () => {
    const findMany = vi.spyOn(prisma.assignment, 'findMany');
    const raw = vi.spyOn(prisma, '$queryRaw');
    const quality = await projectQuality(fx.project);
    expect(findMany).not.toHaveBeenCalled();
    expect(raw.mock.calls.length).toBeLessThanOrEqual(2);
    findMany.mockRestore();
    raw.mockRestore();

    // the numbers follow from how the fixture is built
    const submitted = await prisma.assignment.count({
      where: { projectId: fx.project.id, status: 'SUBMITTED' },
    });
    const skipped = await prisma.assignment.count({
      where: { projectId: fx.project.id, status: 'SKIPPED' },
    });
    expect(quality.annotators.reduce((s, a) => s + a.submitted, 0)).toBe(submitted);
    expect(quality.annotators.reduce((s, a) => s + a.skipped, 0)).toBe(skipped);
    expect(quality.annotators).toHaveLength(20);
    expect(quality.agreement.fleiss).not.toBeNull();
  });
});
