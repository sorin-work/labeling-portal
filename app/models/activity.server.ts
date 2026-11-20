import type { Prisma } from '@prisma/client';

import { isActivityAction, type ActivityAction } from '~/domain/activity';
import { readRange } from '~/lib/dates';
import { prisma } from '~/lib/db.server';

type Db = typeof prisma | Prisma.TransactionClient;

export type ActivityInput = {
  action: ActivityAction;
  actorId: string;
  /** the organisation; taken from the project when the entry is about one */
  orgId?: string;
  projectId?: string | null;
  detail?: Prisma.InputJsonValue;
  createdAt?: Date;
};

/**
 * Adds an entry to the audit trail. Pass the transaction that makes the
 * change, so the entry and the change are committed together or not at all.
 * Entries are never changed or removed: there is no function for it here,
 * and the database refuses it.
 */
export async function logActivity(db: Db, input: ActivityInput) {
  const actor = await db.user.findUniqueOrThrow({
    where: { id: input.actorId },
    select: { name: true },
  });
  const orgId =
    input.orgId ??
    (
      await db.project.findUniqueOrThrow({
        where: { id: input.projectId ?? '' },
        select: { orgId: true },
      })
    ).orgId;
  return db.activity.create({
    data: {
      orgId,
      projectId: input.projectId ?? null,
      actorId: input.actorId,
      actorName: actor.name,
      action: input.action,
      detail: input.detail,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

export type ActivityFilter = {
  orgId: string;
  projectId?: string | null;
  actorId?: string | null;
  action?: string | null;
  /** UTC days, both included */
  range?: { from: string; to: string } | null;
};

function where(filter: ActivityFilter): Prisma.ActivityWhereInput {
  const { range } = filter;
  return {
    orgId: filter.orgId,
    ...(filter.projectId ? { projectId: filter.projectId } : {}),
    ...(filter.actorId ? { actorId: filter.actorId } : {}),
    ...(filter.action ? { action: filter.action } : {}),
    ...(range
      ? {
          createdAt: {
            gte: new Date(`${range.from}T00:00:00Z`),
            lt: new Date(new Date(`${range.to}T00:00:00Z`).getTime() + 24 * 60 * 60_000),
          },
        }
      : {}),
  };
}

const ENTRY = {
  id: true,
  action: true,
  detail: true,
  createdAt: true,
  actorId: true,
  actorName: true,
  projectId: true,
  project: { select: { name: true } },
} satisfies Prisma.ActivitySelect;

export function countActivity(filter: ActivityFilter) {
  return prisma.activity.count({ where: where(filter) });
}

/** Entries newest first. Every read names the organisation, so nothing of another one comes back. */
export function listActivity(filter: ActivityFilter, page: { skip: number; take: number }) {
  return prisma.activity.findMany({
    where: where(filter),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: page.skip,
    take: page.take,
    select: ENTRY,
  });
}

/** Every matching entry, oldest first, in pages, for the CSV download. */
export async function* allActivity(filter: ActivityFilter, pageSize = 500) {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.activity.findMany({
      where: where(filter),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: ENTRY,
    });
    yield* rows;
    if (rows.length < pageSize) return;
    cursor = rows[rows.length - 1].id;
  }
}

/**
 * The filters of `/audit` from its address: person, action, project and a
 * range of days. Without `from` and `to` there is no date filter. Values
 * that are not ids of the organisation simply match nothing.
 */
export function readActivityFilter(url: URL, orgId: string): ActivityFilter {
  const params = url.searchParams;
  const action = params.get('action');
  return {
    orgId,
    actorId: params.get('person') || null,
    projectId: params.get('project') || null,
    action: isActivityAction(action) ? action : null,
    range: params.get('from') || params.get('to') ? readRange(url) : null,
  };
}
