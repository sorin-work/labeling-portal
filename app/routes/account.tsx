import { data, Form } from 'react-router';

import { Alert, Button, Card, Field, Input, PageHeader } from '~/components/ui';
import { beforeSignOut } from '~/components/use-draft-save';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '~/lib/password.server';
import { ROLE_LABELS } from '~/lib/permissions';
import { formatDateTime } from '~/lib/format';
import { destroyUserSession, renewSessionCookie } from '~/lib/session.server';
import { logActivity } from '~/models/activity.server';
import {
  createApiToken,
  listActiveApiTokens,
  listApiTokens,
  MAX_TOKEN_NAME,
  revokeApiToken,
  TOKEN_LIFETIMES,
} from '~/models/api-tokens.server';
import { endSessions } from '~/models/people.server';

import type { Route } from './+types/account';

export function meta() {
  return [{ title: 'Account · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user, membership } = await requireUser(request);
  // only the person's own tokens, and nothing in them that could be used
  const [tokens, active] = await Promise.all([
    listApiTokens(membership.orgId, user.id),
    listActiveApiTokens(membership.orgId, user.id),
  ]);
  return {
    user,
    role: membership.role,
    tokens,
    activeTokens: active.map((t) => t.name),
    lifetimes: TOKEN_LIFETIMES,
  };
}

type ActionData = {
  error?: string;
  field?: string;
  message?: string;
  /** the token that was just made, shown this once */
  token?: { value: string; name: string };
  tokenError?: string;
};

export async function action({ request }: Route.ActionArgs) {
  const { user, membership } = await requireUser(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? 'password');
  if (intent === 'token-create') {
    const name = String(form.get('name') ?? '').trim();
    if (!name || name.length > MAX_TOKEN_NAME) {
      return data<ActionData>(
        { tokenError: `Give the token a name of 1 to ${MAX_TOKEN_NAME} characters.` },
        { status: 400 },
      );
    }
    const days = Number(form.get('expiresInDays') ?? 0);
    const expiresInDays = (TOKEN_LIFETIMES as readonly number[]).includes(days) ? days : null;
    const created = await createApiToken(membership.orgId, user.id, {
      name,
      // read-only unless writing is asked for
      readOnly: form.get('write') !== 'on',
      expiresInDays,
    });
    return data<ActionData>(
      { token: { value: created.token, name } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (intent === 'token-revoke') {
    const revoked = await revokeApiToken(
      membership.orgId,
      user.id,
      String(form.get('tokenId') ?? ''),
    );
    if (!revoked.ok)
      return data<ActionData>(
        { tokenError: 'That token is not yours or is already revoked.' },
        { status: 404 },
      );
    return data<ActionData>({ message: 'Token revoked.' });
  }
  if (intent === 'sessions') {
    // every browser, this one included; tokens keep working
    await endSessions(membership.orgId, user.id, user.id);
    return destroyUserSession(request);
  }
  if (intent !== 'password') return data<ActionData>({ error: 'Unknown action.' }, { status: 400 });
  const current = String(form.get('current') ?? '');
  const next = String(form.get('next') ?? '');
  const confirm = String(form.get('confirm') ?? '');

  const account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  if (!(await verifyPassword(current, account.passwordHash))) {
    return data<ActionData>(
      { error: 'Your current password is not right.', field: 'current' },
      { status: 400 },
    );
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    return data<ActionData>(
      { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.`, field: 'next' },
      { status: 400 },
    );
  }
  if (next !== confirm) {
    return data<ActionData>(
      { error: 'The new passwords do not match.', field: 'confirm' },
      { status: 400 },
    );
  }
  const passwordHash = await hashPassword(next);
  const updated = await prisma.$transaction(async (tx) => {
    // ends every other session; this tab gets a cookie with the new version below
    const row = await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    });
    // who, and nothing about the password
    await logActivity(tx, {
      orgId: membership.orgId,
      actorId: user.id,
      action: 'account.password',
    });
    return row;
  });
  const active = await listActiveApiTokens(membership.orgId, user.id);
  return data<ActionData>(
    {
      message:
        'Password changed. You are signed out in every other browser.' +
        (active.length > 0 ? ` ${tokensStillWork(active.length)}` : ''),
    },
    { headers: { 'Set-Cookie': await renewSessionCookie(request, updated.sessionVersion) } },
  );
}

function tokensStillWork(count: number) {
  return `Your ${count === 1 ? 'API token still works' : `${count} API tokens still work`}: revoke ${count === 1 ? 'it' : 'them'} below if someone else may have ${count === 1 ? 'it' : 'them'}.`;
}

export default function Account({ loaderData, actionData }: Route.ComponentProps) {
  const { user, role, tokens, activeTokens, lifetimes } = loaderData;
  const result = actionData as ActionData | undefined;
  return (
    <div className="max-w-xl space-y-6">
      <PageHeader title="Your account" subtitle={`${user.email} · ${ROLE_LABELS[role]}`} />
      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Change password
        </h2>
        <Form method="post" className="space-y-3">
          {result?.message && <Alert tone="success">{result.message}</Alert>}
          <Field
            label="Current password"
            htmlFor="current"
            error={result?.field === 'current' ? result.error : undefined}
          >
            <Input
              id="current"
              name="current"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <Field
            label="New password"
            htmlFor="next"
            error={result?.field === 'next' ? result.error : undefined}
          >
            <Input id="next" name="next" type="password" autoComplete="new-password" required />
          </Field>
          <Field
            label="Repeat new password"
            htmlFor="confirm"
            error={result?.field === 'confirm' ? result.error : undefined}
          >
            <Input
              id="confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
            />
          </Field>
          <input type="hidden" name="intent" value="password" />
          <Button type="submit">Change password</Button>
        </Form>
      </Card>
      <Card>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Sessions
        </h2>
        <p className="mb-3 text-sm text-slate-600">
          Signs you out in every browser where you are signed in, this one too. Changing your
          password does the same for every browser but this one.
          {activeTokens.length > 0 &&
            ` API tokens are not sessions and keep working: ${activeTokens.map((n) => `“${n}”`).join(', ')}. Revoke them below if they may be in the wrong hands.`}
        </p>
        <Form
          method="post"
          onSubmit={(event) => {
            if (!confirm('Sign out in every browser, this one too?')) event.preventDefault();
            else beforeSignOut();
          }}
        >
          <input type="hidden" name="intent" value="sessions" />
          <Button type="submit" variant="secondary">
            Sign out everywhere
          </Button>
        </Form>
      </Card>
      <Card>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
          API tokens
        </h2>
        <p className="mb-3 text-sm text-slate-600">
          A token lets a script use the JSON API as you, with your role. It is shown once, when it
          is made. Keep it like a password. See <code>docs/api.md</code>.
        </p>
        {result?.token && (
          <Alert tone="success">
            <div>Your token “{result.token.name}”. Copy it now: it is not shown again.</div>
            <code className="mt-2 block break-all rounded bg-white px-2 py-1 text-slate-900">
              {result.token.value}
            </code>
          </Alert>
        )}
        {result?.tokenError && <Alert>{result.tokenError}</Alert>}
        <Form method="post" className="space-y-3">
          <input type="hidden" name="intent" value="token-create" />
          <Field label="Name" htmlFor="token-name">
            <Input
              id="token-name"
              name="name"
              maxLength={80}
              required
              placeholder="Nightly import"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="write" />
            It may write (import batches). Without this the token can only read.
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-600">Expires</span>
            <select
              name="expiresInDays"
              defaultValue="90"
              className="block rounded-md border-0 py-2 pl-2 pr-8 text-sm ring-1 ring-slate-300"
            >
              {lifetimes.map((days) => (
                <option key={days} value={days}>
                  after {days} days
                </option>
              ))}
              <option value="0">never</option>
            </select>
          </label>
          <Button type="submit" variant="secondary">
            Make a token
          </Button>
        </Form>
        {tokens.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-100 text-sm">
            {tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{t.name}</span>{' '}
                  <code className="text-slate-500">{t.prefix}…</code>{' '}
                  <span className="text-slate-500">
                    {t.readOnly ? 'read-only' : 'read and write'} · made{' '}
                    {formatDateTime(t.createdAt)}
                    {t.lastUsedAt
                      ? ` · last used ${formatDateTime(t.lastUsedAt)}`
                      : ' · never used'}
                    {t.revokedAt
                      ? ` · revoked ${formatDateTime(t.revokedAt)}`
                      : t.expiresAt
                        ? ` · expires ${formatDateTime(t.expiresAt)}`
                        : ''}
                  </span>
                </span>
                {!t.revokedAt && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="token-revoke" />
                    <input type="hidden" name="tokenId" value={t.id} />
                    <Button type="submit" variant="secondary">
                      Revoke
                    </Button>
                  </Form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
