import { Link } from 'react-router';

import { Badge, EmptyState, PageHeader } from '~/components/ui';
import { NOTIFICATION_RETENTION_DAYS, NOTIFICATIONS_SHOWN } from '~/domain/notifications';
import { requireUser } from '~/lib/auth.server';
import { formatDateTime } from '~/lib/format';
import { openNotifications } from '~/models/notifications.server';

import type { Route } from './+types/notifications';

export function meta() {
  return [{ title: 'Notifications · Labeling Portal' }];
}

/**
 * The signed-in person's notifications in their organisation. Whose they
 * are comes from the session only. Opening the page reads them, so the count
 * in the header goes back to zero.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { user, membership } = await requireUser(request);
  return { notifications: await openNotifications(user.id, membership.orgId) };
}

export default function Notifications({ loaderData }: Route.ComponentProps) {
  const { notifications } = loaderData;
  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle={`The latest ${NOTIFICATIONS_SHOWN}. Read ones go after ${NOTIFICATION_RETENTION_DAYS} days.`}
      />
      {notifications.length === 0 ? (
        <EmptyState title="Nothing yet">
          Send-backs, corrections, disputes and other news about your work show up here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg bg-white text-sm shadow-sm ring-1 ring-slate-200">
          {notifications.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              {n.isNew && <Badge tone="indigo">New</Badge>}
              <Link to={n.link} className="min-w-0 flex-1 hover:text-indigo-700">
                {n.text}
              </Link>
              <span className="text-xs text-slate-500">{formatDateTime(n.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
