import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { payoutReport } from '~/models/payouts.server';

import { prisma } from './helpers';

/**
 * The two migrations that freeze rates and store the day work became payable.
 * This test builds a database as it is before them, with accepted, pending
 * and sent-back work in it, reads the pay report the way it was computed then,
 * applies the two migrations and reads the report as it is computed now.
 * Migrations run in their order: every one before the first of the two, then
 * the history, then the rest from there (the two and whatever came between or
 * after them), as `prisma migrate deploy` would run them on an upgrade.
 */
const UPGRADE = ['20261120191722_frozen_pay_rate', '20261120200249_payable_at'];

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const name = `labeling_pay_upgrade_${process.pid}_${Date.now()}`;
let scratch: PrismaClient;

/**
 * The statements of a migration file, split on the semicolons that end a
 * line. A function body between dollar quotes is kept in one piece.
 */
function statements(folder: string): string[] {
  const text = readFileSync(join(MIGRATIONS, folder, 'migration.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const quote = '$' + '$';
  const out: string[] = [];
  let current = '';
  text.split(quote).forEach((part, i) => {
    if (i % 2 === 1) {
      // inside a body: no splitting
      current += quote + part + quote;
      return;
    }
    const pieces = part.split(/;\s*(?:\n|$)/);
    current += pieces[0];
    for (const piece of pieces.slice(1)) {
      out.push(current);
      current = piece;
    }
  });
  out.push(current);
  return out.map((statement) => statement.trim()).filter(Boolean);
}

async function apply(folders: string[]) {
  for (const folder of folders) {
    for (const statement of statements(folder)) await scratch.$executeRawUnsafe(statement);
  }
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  scratch = new PrismaClient({ datasources: { db: { url: url.toString() } } });
});

afterAll(async () => {
  await scratch.$disconnect();
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});

type Old = {
  userId: string;
  payMode: 'PER_TASK' | 'HOURLY';
  rateCents: number;
  tasks: number;
  seconds: number;
};

/** The report as it was before the upgrade: accepted work by its submission day, at the project's current rate. */
async function oldReport(from: string, to: string) {
  const rows = await scratch.$queryRawUnsafe<Old[]>(
    `SELECT a."userId", p."payMode", p."rateCents", count(*)::int AS tasks,
            sum(a."activeSeconds")::int AS seconds
     FROM "Assignment" a JOIN "Project" p ON p.id = a."projectId"
     WHERE a.status = 'SUBMITTED' AND a."reviewStatus" IN ('APPROVED', 'FIXED', 'NOT_REQUIRED')
       AND a."submittedAt" >= '${from}T00:00:00Z'::timestamptz AT TIME ZONE 'UTC'
       AND a."submittedAt" < ('${to}T00:00:00Z'::timestamptz + interval '1 day') AT TIME ZONE 'UTC'
     GROUP BY a."userId", a."projectId", p."payMode", p."rateCents"`,
  );
  const perPerson = new Map<string, number>();
  for (const row of rows) {
    const amount =
      row.payMode === 'PER_TASK'
        ? row.rateCents * row.tasks
        : Math.round((row.rateCents * row.seconds) / 3600);
    perPerson.set(row.userId, (perPerson.get(row.userId) ?? 0) + amount);
  }
  const pending = await scratch.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT count(*)::int AS count FROM "Assignment" a
     WHERE a.status = 'SUBMITTED' AND a."reviewStatus" IN ('PENDING', 'SENT_BACK')
       AND a."submittedAt" >= '${from}T00:00:00Z'::timestamptz AT TIME ZONE 'UTC'
       AND a."submittedAt" < ('${to}T00:00:00Z'::timestamptz + interval '1 day') AT TIME ZONE 'UTC'`,
  );
  return {
    perPerson: Object.fromEntries([...perPerson].sort()),
    totalCents: [...perPerson.values()].reduce((sum, cents) => sum + cents, 0),
    pending: pending[0].count,
  };
}

async function newReport(from: string, to: string) {
  const report = await payoutReport('org', { from, to }, null, scratch);
  return {
    perPerson: Object.fromEntries(report.lines.map((l) => [l.userId, l.amountCents]).sort()),
    totalCents: report.totalCents,
    pending: report.pending,
  };
}

const PERIODS: Array<[string, string]> = [
  ['2026-01-01', '2026-01-31'],
  ['2026-02-01', '2026-02-28'],
  ['2026-03-01', '2026-03-31'],
  ['2026-01-01', '2026-03-31'],
  ['2026-01-31', '2026-02-01'],
];

describe('upgrading a database that already has pay history', () => {
  it('leaves every period of the pay report as it was', async () => {
    const all = readdirSync(MIGRATIONS)
      .filter((entry) => !entry.endsWith('.toml'))
      .sort();
    expect(all).toEqual(expect.arrayContaining(UPGRADE));
    const first = all.indexOf(UPGRADE[0]);
    expect(all.indexOf(UPGRADE[1])).toBeGreaterThan(first);
    await apply(all.slice(0, first));

    // history as the old code wrote it: no rate on the work, no payable date
    const sql = (statement: string) => scratch.$executeRawUnsafe(statement);
    await sql(`INSERT INTO "Organization" (id, name, slug) VALUES ('org', 'Org', 'org')`);
    await sql(`INSERT INTO "User" (id, email, name, "passwordHash") VALUES
      ('ann', 'ann@example.test', 'Ann', 'x'), ('ben', 'ben@example.test', 'Ben', 'x'),
      ('rev', 'rev@example.test', 'Rev', 'x')`);
    await sql(`INSERT INTO "Project" (id, "orgId", name, kind, schema, "payMode", "rateCents", "updatedAt") VALUES
      ('tasks', 'org', 'Per task', 'TEXT_CLASSIFICATION', '{}', 'PER_TASK', 35, now()),
      ('hours', 'org', 'Hourly', 'TEXT_CLASSIFICATION', '{}', 'HOURLY', 1800, now())`);
    await sql(`INSERT INTO "Batch" (id, "projectId", name, format) VALUES
      ('b1', 'tasks', 'b', 'CSV'), ('b2', 'hours', 'b', 'CSV')`);
    const work: Array<[string, string, string, string, string, string | null, number]> = [
      // id, project, user, submitted, review status, reviewed, active seconds
      ['a1', 'tasks', 'ann', '2026-01-10 09:00', 'APPROVED', '2026-01-12 09:00', 40],
      // approved in the month after it was submitted
      ['a2', 'tasks', 'ann', '2026-01-30 09:00', 'APPROVED', '2026-02-02 09:00', 40],
      ['a3', 'tasks', 'ann', '2026-02-05 09:00', 'NOT_REQUIRED', null, 40],
      // fixed, by code that did not date the review on the submission
      ['a4', 'tasks', 'ann', '2026-02-06 09:00', 'FIXED', null, 40],
      ['a5', 'tasks', 'ann', '2026-02-08 09:00', 'PENDING', null, 40],
      ['a6', 'tasks', 'ann', '2026-01-20 09:00', 'SENT_BACK', '2026-01-21 09:00', 40],
      ['a7', 'tasks', 'ben', '2026-02-27 23:30', 'APPROVED', '2026-03-01 08:00', 40],
      // hourly, where the rounding of a block must not move either
      ['h1', 'hours', 'ben', '2026-01-15 09:00', 'APPROVED', '2026-01-15 12:00', 61],
      ['h2', 'hours', 'ben', '2026-01-31 23:50', 'APPROVED', '2026-02-01 00:10', 61],
      ['h3', 'hours', 'ben', '2026-02-10 09:00', 'NOT_REQUIRED', null, 3001],
      ['h4', 'hours', 'ann', '2026-03-03 09:00', 'APPROVED', '2026-03-04 09:00', 1234],
    ];
    for (const [id, project, user, submitted, status, reviewed, seconds] of work) {
      await sql(`INSERT INTO "Task" (id, "projectId", "batchId", position, data) VALUES
        ('t-${id}', '${project}', '${project === 'tasks' ? 'b1' : 'b2'}', ${work.findIndex((w) => w[0] === id) + 1}, '{}')`);
      await sql(`INSERT INTO "Assignment"
        (id, "projectId", "taskId", "userId", status, "expiresAt", "submittedAt", "reviewStatus", "reviewedAt", "activeSeconds", answer)
        VALUES ('${id}', '${project}', 't-${id}', '${user}', 'SUBMITTED', '${submitted}', '${submitted}',
          '${status}', ${reviewed ? `'${reviewed}'` : 'NULL'}, ${seconds}, '{}')`);
    }
    await sql(`INSERT INTO "Review" (id, "assignmentId", "reviewerId", decision, "createdAt")
      VALUES ('r4', 'a4', 'rev', 'FIX', '2026-02-07 09:00')`);
    // a claim that was never submitted
    await sql(
      `INSERT INTO "Task" (id, "projectId", "batchId", position, data) VALUES ('t-c', 'tasks', 'b1', 99, '{}')`,
    );
    await sql(`INSERT INTO "Assignment" (id, "projectId", "taskId", "userId", "expiresAt")
      VALUES ('c1', 'tasks', 't-c', 'ann', '2026-02-08 09:00')`);

    const before = [];
    for (const [from, to] of PERIODS) before.push(await oldReport(from, to));
    // the fixture is worth something: money in every month and across the boundary
    expect(before.map((period) => period.totalCents)).toEqual([131, 1606, 617, 2354, 31]);

    await apply(all.slice(first));

    const after = [];
    for (const [from, to] of PERIODS) after.push(await newReport(from, to));
    expect(after).toEqual(before);

    // why: accepted work carries its submission day and its project's rate
    const stored = await scratch.assignment.findMany({ orderBy: { id: 'asc' } });
    for (const row of stored) {
      const accepted = ['APPROVED', 'FIXED', 'NOT_REQUIRED'].includes(row.reviewStatus ?? '');
      expect(row.payableAt, row.id).toEqual(accepted ? row.submittedAt : null);
      const submitted = row.status === 'SUBMITTED';
      expect(row.rateCents, row.id).toBe(!submitted ? null : row.projectId === 'tasks' ? 35 : 1800);
    }
  });
});
