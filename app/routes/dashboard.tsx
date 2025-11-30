import { requireUser } from '~/lib/auth.server';
import { ROLE_LABELS } from '~/lib/permissions';

import type { Route } from './+types/dashboard';

export function meta() {
  return [{ title: 'Dashboard · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user, membership } = await requireUser(request);
  return { user, role: membership.role };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Welcome back, {loaderData.user.name}</h1>
      <p className="mt-1 text-slate-600">You are signed in as {ROLE_LABELS[loaderData.role]}.</p>
    </div>
  );
}
