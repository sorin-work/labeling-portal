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
 * The first lock of every transaction that writes an assignment: its task's
 * row. The slot counter's trigger updates that row when an assignment changes
 * state, so every writer takes the task row before the assignment row, and
 * two of them can only queue, never wait for each other in a circle.
 */
export async function lockTaskOfAssignment(
  tx: Prisma.TransactionClient,
  assignmentId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT t.id FROM "Task" t JOIN "Assignment" a ON a."taskId" = t.id
    WHERE a.id = ${assignmentId}
    FOR NO KEY UPDATE OF t`;
}

/**
 * A deadlock (40P01) or a serialization failure (40001) that PostgreSQL
 * resolved by aborting us, a lock wait that ran out (55P03, `lock_timeout`),
 * or a transaction Prisma gave up on (P2028). All of them are worth one more
 * try rather than an error for the person.
 */
export function isLockConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034' || error.code === 'P2028') return true;
    const code = (error.meta as { code?: string } | undefined)?.code;
    if (code === '40P01' || code === '40001' || code === '55P03') return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(40P01|40001|55P03|P2028)\b|deadlock detected|could not serialize|lock timeout/.test(
    message,
  );
}

/**
 * Runs a transaction again, once, when PostgreSQL aborted it to break a
 * deadlock or a serialization conflict. The lock order above should make that
 * impossible; this is the backstop. The work must be safe to repeat, which
 * every caller's conditional writes make it.
 */
export async function retryOnLockConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isLockConflict(error)) throw error;
    return run();
  }
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
