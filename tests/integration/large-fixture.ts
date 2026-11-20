import { Prisma } from '@prisma/client';

import { createMember, createOrg, createTestProject, prisma } from './helpers';

export type LargeFixture = Awaited<ReturnType<typeof createLargeProject>>;

/**
 * A text classification project with `tasks` tasks in ten batches, built with
 * a few set-based statements so it takes seconds, not minutes. Overlap 2,
 * every 50th task gold. Positions are laid out the way a busy project looks:
 *
 * - the first half is complete: two approved answers each, some reviewed
 *   with a QA score, some corrected by the reviewer, some split;
 * - the next 40% is full but not complete: two answers waiting for review,
 *   which the queue has to pass over on every claim;
 * - the last 10% is open, a third of it with one answer already;
 * - one skip for every 40 tasks.
 *
 * Twenty annotators and one reviewer. Everything is deterministic: the same
 * size gives the same data, apart from generated ids and times.
 */
export async function createLargeProject(tasks = 20_000) {
  const org = await createOrg('Large Org');
  const project = await createTestProject(org.id, { overlap: 2, name: 'Large' });
  const first = await createMember(org.id, 'ANNOTATOR');
  const reviewer = await createMember(org.id, 'REVIEWER');
  const people = 20;
  // the other annotators share the first one's password hash: bcrypt is slow
  await prisma.$executeRaw`
    INSERT INTO "User" (id, email, name, "passwordHash")
    SELECT 'u' || g, 'annotator' || g || '@large.test', 'Annotator ' || g, ${first.passwordHash}
    FROM generate_series(2, ${people}) g`;
  await prisma.$executeRaw`
    INSERT INTO "Membership" (id, "orgId", "userId", role)
    SELECT 'm' || g, ${org.id}, 'u' || g, 'ANNOTATOR' FROM generate_series(2, ${people}) g`;
  const users = [first.id, ...Array.from({ length: people - 1 }, (_, i) => `u${i + 2}`)];
  await prisma.projectMember.createMany({
    data: users.map((userId) => ({ projectId: project.id, userId })),
  });
  const userAt = Prisma.sql`(ARRAY[${Prisma.join(users)}])`;

  await prisma.$executeRaw`
    INSERT INTO "Batch" (id, "projectId", name, format)
    SELECT ${project.id} || '-b' || g, ${project.id}, 'batch ' || g, 'JSONL'
    FROM generate_series(1, 10) g`;
  const half = Math.floor(tasks / 2);
  const full = Math.floor(tasks * 0.9);
  await prisma.$executeRaw`
    INSERT INTO "Task" (id, "projectId", "batchId", position, "externalId", data, status,
                        "isGold", "goldAnswer", consensus, agreement, "completedAt")
    SELECT ${project.id} || '-t' || g, ${project.id},
           ${project.id} || '-b' || (1 + (g - 1) * 10 / ${tasks}), g, 'x' || g,
           jsonb_build_object('id', 'x' || g, 'text', 'review number ' || g),
           CASE WHEN g <= ${half} AND g % 50 <> 0 THEN 'COMPLETE'::"TaskStatus" ELSE 'OPEN'::"TaskStatus" END,
           g % 50 = 0,
           CASE WHEN g % 50 = 0 THEN '{"labels":["positive"]}'::jsonb END,
           CASE WHEN g <= ${half} AND g % 50 <> 0 AND g % 7 <> 0
                THEN jsonb_build_object('labels', jsonb_build_array(CASE WHEN g % 2 = 0 THEN 'positive' ELSE 'negative' END)) END,
           CASE WHEN g <= ${half} AND g % 50 <> 0 THEN CASE WHEN g % 7 = 0 THEN 0.5 ELSE 1 END END,
           CASE WHEN g <= ${half} AND g % 50 <> 0 THEN now() - interval '1 day' END
    FROM generate_series(1, ${tasks}) g`;

  // two answers on every task up to the open tail, one on a third of the tail
  await prisma.$executeRaw`
    INSERT INTO "Assignment" (id, "projectId", "taskId", "userId", status, "claimedAt",
                              "expiresAt", "submittedAt", answer, "activeSeconds",
                              "reviewStatus", "goldScore")
    SELECT ${project.id} || '-a' || g || '-' || k, ${project.id}, ${project.id} || '-t' || g,
           ${userAt}[1 + (g + k * 7) % ${people}], 'SUBMITTED',
           now() - interval '2 days' + interval '1 second' * g,
           now() - interval '2 days' + interval '1 second' * g + interval '30 minutes',
           now() - interval '2 days' + interval '1 second' * g + interval '1 minute',
           jsonb_build_object('labels', jsonb_build_array(
             CASE WHEN (g % 7 = 0 AND k = 1) OR (g % 7 <> 0 AND g % 2 = 1) THEN 'negative' ELSE 'positive' END)),
           20 + (g * 13 + k * 5) % 90,
           CASE WHEN g % 50 = 0 THEN 'NOT_REQUIRED'::"ReviewStatus"
                WHEN g <= ${half} THEN 'APPROVED'::"ReviewStatus"
                ELSE 'PENDING'::"ReviewStatus" END,
           CASE WHEN g % 50 = 0 THEN CASE WHEN (g + k) % 3 = 0 THEN 0 ELSE 1 END END
    FROM generate_series(1, ${tasks}) g, generate_series(0, 1) k
    WHERE g <= ${full} OR (k = 0 AND g % 3 = 0)`;
  // a review with a QA score on every fourth complete task, a fix on every twentieth
  await prisma.$executeRaw`
    INSERT INTO "Review" (id, "assignmentId", "reviewerId", decision, "qaScore", "correctedAnswer", "createdAt")
    SELECT ${project.id} || '-r' || g, ${project.id} || '-a' || g || '-0', ${reviewer.id},
           CASE WHEN g % 20 = 0 THEN 'FIX'::"ReviewDecision" ELSE 'APPROVE'::"ReviewDecision" END,
           1 + g % 5,
           CASE WHEN g % 20 = 0 THEN '{"labels":["negative"]}'::jsonb END,
           now() - interval '1 day'
    FROM generate_series(1, ${half}) g
    WHERE g % 4 = 0 AND g % 50 <> 0`;
  await prisma.$executeRaw`
    UPDATE "Assignment" SET "reviewStatus" = 'FIXED'
    WHERE id IN (
      SELECT ${project.id} || '-a' || g || '-0' FROM generate_series(1, ${half}) g
      WHERE g % 20 = 0 AND g % 50 <> 0)`;
  await prisma.$executeRaw`
    INSERT INTO "Assignment" (id, "projectId", "taskId", "userId", status, "claimedAt",
                              "expiresAt", "skipReason")
    SELECT ${project.id} || '-s' || g, ${project.id}, ${project.id} || '-t' || g,
           ${userAt}[1 + (g + 3) % ${people}], 'SKIPPED',
           now() - interval '3 days', now() - interval '3 days' + interval '30 minutes',
           CASE WHEN g % 80 = 0 THEN 'Other: unreadable' ELSE 'Unclear instructions' END
    FROM generate_series(40, ${tasks}, 40) g`;
  await prisma.$executeRaw`ANALYZE`;
  const fresh = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  return { org, project: fresh, users, reviewer, tasks };
}
