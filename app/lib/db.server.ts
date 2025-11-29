import { PrismaClient } from '@prisma/client';

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
