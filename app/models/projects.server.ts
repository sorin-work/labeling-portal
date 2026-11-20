import { Prisma, type PrismaClient, type Project } from '@prisma/client';

import type { ProjectInput } from '~/domain/project-form';
import type { SchemaUsage } from '~/domain/schema-diff';
import { KIND_TO_ENUM, parseTaskSchema, type TaskSchema } from '~/domain/task-schema';
import type { CurrentUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { forbidden, notFound } from '~/lib/http';
import { can, type Capability } from '~/lib/permissions';

type Db = PrismaClient | Prisma.TransactionClient;

/** Admins and project managers see every project in the org; others only their own. */
function visibleProjectsWhere(current: CurrentUser): Prisma.ProjectWhereInput {
  const base: Prisma.ProjectWhereInput = { orgId: current.membership.orgId };
  if (can(current.membership.role, 'manageProjects')) return base;
  return {
    ...base,
    status: { in: ['ACTIVE', 'PAUSED'] },
    members: { some: { userId: current.user.id } },
  };
}

export async function listProjects(current: CurrentUser) {
  return prisma.project.findMany({
    where: visibleProjectsWhere(current),
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      description: true,
      kind: true,
      status: true,
      overlap: true,
      createdAt: true,
      _count: { select: { members: true } },
    },
  });
}

/**
 * Loads a project the current user may see, optionally requiring a capability.
 * Projects from other organisations are reported as missing, not forbidden.
 */
export async function requireProject(
  current: CurrentUser,
  projectId: string,
  capability?: Capability,
): Promise<Project> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ...visibleProjectsWhere(current) },
  });
  if (!project) throw notFound('Project not found');
  if (capability && !can(current.membership.role, capability)) throw forbidden();
  return project;
}

export function projectSchema(project: Pick<Project, 'schema'>): TaskSchema {
  const parsed = parseTaskSchema(project.schema);
  if (!parsed.ok) throw new Error(`Stored project schema is invalid: ${parsed.errors.join(', ')}`);
  return parsed.schema;
}

export async function createProject(orgId: string, input: ProjectInput) {
  return prisma.project.create({
    data: {
      orgId,
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      overlap: input.overlap,
      timeLimitMinutes: input.timeLimitMinutes,
      reviewRequired: input.reviewRequired,
      qualificationRequired: input.qualificationRequired,
      qualificationPassPercent: input.qualificationPassPercent,
      payMode: input.payMode,
      rateCents: input.rateCents,
      kind: KIND_TO_ENUM[input.schema.kind],
      schema: input.schema as Prisma.InputJsonValue,
    },
  });
}

/** A JSON array, or an empty one when the value is anything else. */
function arrayAt(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END`;
}

/** A JSON object, or an empty one when the value is anything else. */
function objectAt(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE WHEN jsonb_typeof(${value}) = 'object' THEN ${value} ELSE '{}'::jsonb END`;
}

/**
 * Counts what the stored work of a project uses from its schema, in one
 * statement so every number comes from the same snapshot. It reads the five
 * columns that hold answers: `Assignment.answer`, `Review.correctedAnswer`,
 * `Task.goldAnswer`, `Task.consensus` and `QualificationAttempt.answers` (a
 * map from task id to answer). Attempt answers are kept as they were posted,
 * so nothing here trusts the shape of a value before it is taken apart.
 */
export async function schemaUsage(projectId: string, db: Db = prisma): Promise<SchemaUsage> {
  const rows = await db.$queryRaw<Array<{ metric: string; name: string | null; count: number }>>`
    WITH stored AS (
      SELECT a.answer AS answer FROM "Assignment" a WHERE a."projectId" = ${projectId}
      UNION ALL
      SELECT r."correctedAnswer"
      FROM "Review" r JOIN "Assignment" a ON a.id = r."assignmentId"
      WHERE a."projectId" = ${projectId}
      UNION ALL
      SELECT t."goldAnswer" FROM "Task" t WHERE t."projectId" = ${projectId}
      UNION ALL
      SELECT t.consensus FROM "Task" t WHERE t."projectId" = ${projectId}
      UNION ALL
      SELECT e.value
      FROM "QualificationAttempt" q
      CROSS JOIN LATERAL jsonb_each(${objectAt(Prisma.sql`q.answers`)}) e
      WHERE q."projectId" = ${projectId}
    ),
    answers AS (
      SELECT row_number() OVER () AS id, answer FROM stored WHERE jsonb_typeof(answer) = 'object'
    ),
    names AS (
      SELECT a.id, 'labels' AS source, e.value #>> '{}' AS name
      FROM answers a
      CROSS JOIN LATERAL jsonb_array_elements(${arrayAt(Prisma.sql`a.answer->'labels'`)}) e
      WHERE jsonb_typeof(e.value) = 'string'
      UNION
      SELECT a.id, 'spans', e.value->>'label'
      FROM answers a
      CROSS JOIN LATERAL jsonb_array_elements(${arrayAt(Prisma.sql`a.answer->'spans'`)}) e
      WHERE jsonb_typeof(e.value->'label') = 'string'
      UNION
      SELECT a.id, 'boxes', e.value->>'label'
      FROM answers a
      CROSS JOIN LATERAL jsonb_array_elements(${arrayAt(Prisma.sql`a.answer->'boxes'`)}) e
      WHERE jsonb_typeof(e.value->'label') = 'string'
    ),
    scores AS (
      SELECT s.id,
        ${objectAt(Prisma.sql`s.answer->'scores'->'a'`)} AS a,
        ${objectAt(Prisma.sql`s.answer->'scores'->'b'`)} AS b
      FROM answers s
    ),
    scored AS (
      SELECT id, a, b FROM scores WHERE a <> '{}'::jsonb OR b <> '{}'::jsonb
    )
    SELECT 'tasks' AS metric, NULL::text AS name, count(*)::int AS count
    FROM "Task" WHERE "projectId" = ${projectId}
    UNION ALL
    SELECT 'answers', NULL, count(*)::int FROM answers
    UNION ALL
    SELECT 'name', name, count(DISTINCT id)::int FROM names GROUP BY name
    UNION ALL
    SELECT 'multiLabel', NULL, count(*)::int
    FROM (SELECT id FROM names WHERE source = 'labels' GROUP BY id HAVING count(*) > 1) multi
    UNION ALL
    SELECT 'ties', NULL, count(*)::int FROM answers WHERE answer->>'preference' = 'tie'
    UNION ALL
    SELECT 'scored', NULL, count(*)::int FROM scored
    UNION ALL
    SELECT 'dimension', k.key, count(*)::int
    FROM scored s CROSS JOIN LATERAL jsonb_object_keys(s.a) AS k(key)
    WHERE s.b -> k.key IS NOT NULL
    GROUP BY k.key`;

  const total = (metric: string) => rows.find((r) => r.metric === metric)?.count ?? 0;
  const byName = (metric: string) =>
    new Map(rows.filter((r) => r.metric === metric).map((r) => [r.name ?? '', r.count]));
  return {
    tasks: total('tasks'),
    answers: total('answers'),
    names: byName('name'),
    multiLabel: total('multiLabel'),
    ties: total('ties'),
    scored: total('scored'),
    dimensions: byName('dimension'),
  };
}

export async function updateProject(projectId: string, input: ProjectInput, now = new Date()) {
  const before = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { instructions: true },
  });
  const instructionsChanged = before.instructions.trim() !== input.instructions.trim();
  return prisma.project.update({
    where: { id: projectId },
    data: {
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      ...(instructionsChanged ? { instructionsUpdatedAt: now } : {}),
      overlap: input.overlap,
      timeLimitMinutes: input.timeLimitMinutes,
      reviewRequired: input.reviewRequired,
      qualificationRequired: input.qualificationRequired,
      qualificationPassPercent: input.qualificationPassPercent,
      payMode: input.payMode,
      rateCents: input.rateCents,
      kind: KIND_TO_ENUM[input.schema.kind],
      schema: input.schema as Prisma.InputJsonValue,
    },
  });
}

/**
 * Copies a project's setup (schema, instructions, rates, members) into a new
 * draft. Tasks, submissions and qualification results are not copied.
 */
export async function duplicateProject(project: Project) {
  const members = await prisma.projectMember.findMany({
    where: { projectId: project.id },
    select: { userId: true },
  });
  return prisma.project.create({
    data: {
      orgId: project.orgId,
      name: `${project.name} (copy)`.slice(0, 120),
      description: project.description,
      instructions: project.instructions,
      kind: project.kind,
      schema: project.schema as Prisma.InputJsonValue,
      overlap: project.overlap,
      timeLimitMinutes: project.timeLimitMinutes,
      reviewRequired: project.reviewRequired,
      qualificationRequired: project.qualificationRequired,
      qualificationPassPercent: project.qualificationPassPercent,
      payMode: project.payMode,
      rateCents: project.rateCents,
      members: { create: members },
    },
  });
}
