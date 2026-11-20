import { createHmac } from 'node:crypto';

import { sessionSecret } from './env.server';

/**
 * A stand-in for the user's id where a page only needs something that is
 * the same for one user and different between users, such as the key of the
 * unsaved work a tab keeps. The id itself stays on the server.
 */
export function userTag(userId: string): string {
  return createHmac('sha256', sessionSecret())
    .update(`tab:${userId}`)
    .digest('base64url')
    .slice(0, 22);
}
