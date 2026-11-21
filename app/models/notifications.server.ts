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
 * The person's notifications in the organisation they are signed in to,
 * newest first. Opening the page reads them: what was unread is marked read
 * here and comes back flagged as new. Read ones older than the retention are
 * removed first, so the table holds a few months per person.
 */
export async function openNotifications(userId: string, orgId: string, now = new Date()) {
  const horizon = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 24 * 3600_000);
  await prisma.notification.deleteMany({
    where: { userId, readAt: { not: null }, createdAt: { lt: horizon } },
  });
  const rows = await prisma.notification.findMany({
    where: { userId, orgId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: NOTIFICATIONS_SHOWN,
  });
  const unread = rows.filter((r) => r.readAt === null).map((r) => r.id);
  if (unread.length > 0) {
    // only the person's own rows, whatever ids came in
    await prisma.notification.updateMany({
      where: { id: { in: unread }, userId, readAt: null },
      data: { readAt: now },
    });
  }
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    text: describeNotification(r.kind, r.detail),
    link: r.link,
    createdAt: r.createdAt,
    isNew: r.readAt === null,
  }));
}
