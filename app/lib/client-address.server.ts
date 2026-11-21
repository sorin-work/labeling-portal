import { trustProxy } from './env.server';

declare module 'react-router' {
  interface AppLoadContext {
    /** the socket's peer address, from `docker/server.mjs` */
    clientAddress?: string;
  }
}

/**
 * The client's address, for the limits that should not lock the owner of an
 * account out when someone else is guessing from another place.
 *
 * - With `TRUST_PROXY=true`: the last entry of `X-Forwarded-For` (the one the
 *   proxy in front added), or `X-Real-IP`, and the socket's peer when the
 *   proxy sent neither.
 * - Otherwise: the socket's peer, which `docker/server.mjs` puts in the load
 *   context, and nothing a client sends is believed. Behind a proxy without
 *   `TRUST_PROXY` every client has the proxy's address, so one attacker can
 *   lock the owner out for fifteen minutes.
 * - `unknown` when neither is there (the development server, tests), so the
 *   limits still apply, to everyone together.
 */
export function clientAddress(
  request: Request,
  context?: { clientAddress?: string } | null,
): string {
  const peer = context?.clientAddress?.trim().slice(0, 64) || null;
  if (trustProxy()) {
    const forwarded = request.headers.get('X-Forwarded-For');
    const last = forwarded?.split(',').at(-1)?.trim();
    if (last) return last.slice(0, 64);
    const real = request.headers.get('X-Real-IP')?.trim();
    if (real) return real.slice(0, 64);
  }
  return peer ?? 'unknown';
}
