import { apiError } from '~/lib/auth.server';

/** Anything else under /api answers JSON, not the app's not-found page. */
export const loader = () => apiError(404, 'There is no such API route.');
export const action = loader;
