import { useEffect, useRef } from 'react';
import { Form, Link, redirect, useFetcher } from 'react-router';

import { Badge, Button, EmptyState, PageHeader } from '~/components/ui';
import { NOTIFICATION_RETENTION_DAYS } from '~/domain/notifications';
import { requireUser } from '~/lib/auth.server';
import { formatDateTime } from '~/lib/format';
import { requireSameOrigin } from '~/lib/http';
import { readPage } from '~/lib/pagination';
import { listNotifications, markRead } from '~/models/notifications.server';

import type { Route } from './+types/notifications';

export function meta() {
  return [{ title: 'Notifications · Labeling Portal' }];
}

/**
 * The signed-in person's notifications in their organisation, unread first.
 * Whose they are comes from the session only. Loading the page changes
 * nothing: a link from another site or a prefetch cannot mark anything read.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { user, membership } = await requireUser(request);
  const page = readPage(new URL(request.url));
  const list = await listNotifications(user.id, membership.orgId, page);
  return { page, ...list, upTo: list.upTo?.toISOString() ?? null };
}

/**
 * POST: marks the person's unread notifications as read, up to the newest one
 * the page showed. The page sends it once it is on screen, and "Mark all as
 * read" sends it without script. A post from another site is refused.
 */
export async function action({ request }: Route.ActionArgs) {
  requireSameOrigin(request);
  const { user, membership } = await requireUser(request);
  const form = await request.formData();
  const upTo = new Date(String(form.get('upTo') ?? ''));
  if (!Number.isNaN(upTo.getTime())) await markRead(user.id, membership.orgId, upTo);
  if (form.get('from') === 'page') return { ok: true };
  return redirect('/notifications');
}

export default function Notifications({ loaderData }: Route.ComponentProps) {
  const { notifications, unread, upTo, hasOlder, page } = loaderData;
  // what is on screen has been seen: say so to the server, once per load
  const fetcher = useFetcher();
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (unread === 0 || !upTo || sent.current === upTo) return;
    sent.current = upTo;
    void fetcher.submit({ upTo, from: 'page' }, { method: 'post' });
  }, [unread, upTo, fetcher]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Notifications"
        subtitle={`Unread ones first. Read ones go after ${NOTIFICATION_RETENTION_DAYS} days.`}
        actions={
          unread > 0 && upTo ? (
            <Form method="post">
              <input type="hidden" name="upTo" value={upTo} />
              <Button variant="secondary">Mark all as read</Button>
            </Form>
          ) : null
        }
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
      {hasOlder && (
        <Link to={`?page=${page + 1}`} className="text-sm text-indigo-700 hover:underline">
          Show older
        </Link>
      )}
    </div>
  );
}
