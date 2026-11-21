import type { Prisma } from '@prisma/client';

import {
  describeNotification,
  NOTIFICATION_RETENTION_DAYS,
  NOTIFICATIONS_SHOWN,
  type NotificationKind,
} from '~/domain/notifications';
import { prisma } from '~/lib/db.server';

type Db = typeof prisma | Prisma.TransactionClient;

export type NotificationInput = {
  userId: string;
  orgId: string;
  projectId?: string | null;
  kind: NotificationKind;
  link: string;
  detail?: Prisma.InputJsonValue;
  createdAt?: Date;
};

/**
 * Writes notifications. Pass the transaction that makes the change, as with
 * `logActivity`, so a change that is refused or rolled back tells nobody.
 * Nobody is told about their own action.
 */
export async function notify(db: Db, inputs: NotificationInput[], actorId?: string) {
  const rows = inputs.filter((n) => n.userId !== actorId);
  if (rows.length === 0) return;
  await db.notification.createMany({
    data: rows.map((n) => ({
      userId: n.userId,
      orgId: n.orgId,
      projectId: n.projectId ?? null,
      kind: n.kind,
      link: n.link,
      detail: n.detail ?? {},
      ...(n.createdAt ? { createdAt: n.createdAt } : {}),
    })),
  });
}

/** The admins and project managers of an organisation, who see every project. */
export async function managersOf(db: Db, orgId: string): Promise<string[]> {
  const rows = await db.membership.findMany({
    where: { orgId, role: { in: ['ADMIN', 'PROJECT_MANAGER'] } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** The unread count in the header: one count on `(userId, readAt)`. */
export function unreadCount(userId: string, orgId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null, orgId } });
}

/**
 * One page of the person's notifications in the organisation they are signed
 * in to: unread ones first, then read ones, each newest first, so nothing
 * unread is ever behind a page of read ones. Reading changes nothing; the
 * page marks them read with a POST (`markRead`).
 */
export async function listNotifications(userId: string, orgId: string, page = 1) {
  const where = { userId, orgId };
  const [total, unread, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
    prisma.notification.findMany({
      where,
      // nulls first: unread before read
      orderBy: [
        { readAt: { sort: 'desc', nulls: 'first' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      skip: (Math.max(1, page) - 1) * NOTIFICATIONS_SHOWN,
      take: NOTIFICATIONS_SHOWN,
    }),
  ]);
  const newest = rows.reduce<Date | null>(
    (at, r) => (at === null || r.createdAt > at ? r.createdAt : at),
    null,
  );
  return {
    total,
    unread,
    hasOlder: page * NOTIFICATIONS_SHOWN < total,
    /** what "mark as read" covers: everything up to the newest one shown */
    upTo: newest,
    notifications: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      text: describeNotification(r.kind, r.detail),
      link: r.link,
      createdAt: r.createdAt,
      isNew: r.readAt === null,
    })),
  };
}

/**
 * Marks the person's unread notifications in the organisation as read, all
 * of them up to `upTo` (the newest one the page showed), so one that arrived
 * after the page was loaded stays unread. Read ones older than the retention
 * are removed at the same moment, so the table holds a few months per person.
 * Only ever the person's own rows.
 */
export async function markRead(userId: string, orgId: string, upTo: Date, now = new Date()) {
  const horizon = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 24 * 3600_000);
  await prisma.$transaction([
    prisma.notification.updateMany({
      where: { userId, orgId, readAt: null, createdAt: { lte: upTo } },
      data: { readAt: now },
    }),
    prisma.notification.deleteMany({
      where: { userId, readAt: { not: null, lt: horizon } },
    }),
  ]);
}
