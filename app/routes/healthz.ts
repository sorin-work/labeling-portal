import { prisma } from '~/lib/db.server';

/** Liveness/readiness probe used by Docker and load balancers. */
export async function loader() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json(
      { status: 'ok', database: 'ok' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { status: 'error', database: 'unreachable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
