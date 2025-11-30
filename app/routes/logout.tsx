import { redirect } from 'react-router';

import { destroyUserSession } from '~/lib/session.server';

import type { Route } from './+types/logout';

export async function action({ request }: Route.ActionArgs) {
  return destroyUserSession(request);
}

export async function loader() {
  return redirect('/');
}
