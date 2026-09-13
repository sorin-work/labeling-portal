import pkg from '../../package.json';

import { prisma } from '~/lib/db.server';

/** Liveness/readiness probe used by Docker and load balancers. */
export async function loader() {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: 'ok', database: 'ok', version: pkg.version }, { headers });
  } catch {
    return Response.json(
      { status: 'error', database: 'unreachable', version: pkg.version },
      { status: 503, headers },
    );
  }
}
