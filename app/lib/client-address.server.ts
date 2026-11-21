import { trustProxy } from './env.server';

/**
 * The client's address, for rate limits that should not lock the owner of an
 * account out when someone else is guessing from another place. React Router
 * hands the app a Fetch request, not the socket, so the only source is the
 * proxy in front: with `TRUST_PROXY=true` it is the last entry of
 * `X-Forwarded-For` (the one that proxy added) or `X-Real-IP`. Without it
 * nothing a client sends is believed and this is null; the limit is then per
 * account only.
 */
export function clientAddress(request: Request): string | null {
  if (!trustProxy()) return null;
  const forwarded = request.headers.get('X-Forwarded-For');
  const last = forwarded?.split(',').at(-1)?.trim();
  if (last) return last.slice(0, 64);
  const real = request.headers.get('X-Real-IP')?.trim();
  return real ? real.slice(0, 64) : null;
}
