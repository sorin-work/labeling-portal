import { Prisma, PrismaClient } from '@prisma/client';

declare global {
  var __prisma: PrismaClient | undefined;
}

/**
 * One Prisma client per process. In development the module is re-evaluated on
 * every change, so the client is cached on globalThis to avoid exhausting
 * database connections.
 */
export const prisma = globalThis.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}

/**
 * A date for raw SQL. Every `DateTime` column is a timestamp without a zone
 * that holds UTC. A bare `${date}` is bound as a timestamp with a zone, and
 * PostgreSQL converts that to the session's time zone before it compares or
 * stores it, which is only right when the database runs in UTC. Always pass
 * dates through this in `$queryRaw` and `$executeRaw`.
 */
export function utc(date: Date): Prisma.Sql {
  return Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;
}
