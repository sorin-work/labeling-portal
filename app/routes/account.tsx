import QRCode from 'qrcode';
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
import { groupSecret, otpauthUri } from '~/domain/totp';
import { TotpKeyMissing } from '~/lib/env.server';
import { endSessions } from '~/models/people.server';
import {
  confirmTwoStepSetup,
  pendingTwoStepSecret,
  startTwoStepSetup,
  turnOffTwoStep,
  twoStepRequiredFor,
  twoStepStatus,
} from '~/models/two-step.server';

import type { Route } from './+types/account';

export function meta() {
  return [{ title: 'Account · Labeling Portal' }];
}

/** The secret being set up, as text and as a QR code drawn here, so nothing is sent anywhere. */
async function setupView(email: string, secret: string) {
  const uri = otpauthUri(secret, email);
  const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { secret: groupSecret(secret), qr };
}

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const { user, membership } = current;
  // only the person's own tokens, and nothing in them that could be used
  const [tokens, active, twoStep, org] = await Promise.all([
    listApiTokens(membership.orgId, user.id),
    listActiveApiTokens(membership.orgId, user.id),
    twoStepStatus(user.id),
    prisma.organization.findUniqueOrThrow({
      where: { id: membership.orgId },
      select: { twoStepRequired: true },
    }),
  ]);
  let setup: { secret: string; qr: string } | null = null;
  try {
    const pending = twoStep.enabledAt ? null : await pendingTwoStepSecret(user.id);
    if (pending) setup = await setupView(user.email, pending);
  } catch (error) {
    if (!(error instanceof TotpKeyMissing)) throw error;
  }
  const url = new URL(request.url);
  return {
    user,
    role: membership.role,
    tokens,
    activeTokens: active.map((t) => t.name),
    lifetimes: TOKEN_LIFETIMES,
    twoStep: {
      ...twoStep,
      required: twoStepRequiredFor(membership.role, org.twoStepRequired),
      mustSetUp: current.mustSetUpTwoStep === true,
      setup,
      recoveryUsed: url.searchParams.get('recovery') === 'used',
    },
  };
}

type ActionData = {
  error?: string;
  field?: string;
  message?: string;
  /** the token that was just made, shown this once */
  token?: { value: string; name: string };
  tokenError?: string;
  twoStepError?: string;
  twoStepMessage?: string;
  /** the recovery codes that were just made, shown this once */
  recoveryCodes?: string[];
};

const KEY_MISSING =
  'Two-step sign-in needs TOTP_KEY on the server. Ask whoever runs it to set one.';

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
  if (intent === 'two-step-start' || intent === 'two-step-confirm' || intent === 'two-step-off') {
    try {
      if (intent === 'two-step-start') {
        const started = await startTwoStepSetup(user.id);
        if (!started.ok) return data<ActionData>({ twoStepError: started.error }, { status: 400 });
        return data<ActionData>({}, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (intent === 'two-step-confirm') {
        const done = await confirmTwoStepSetup(
          membership.orgId,
          user.id,
          String(form.get('code') ?? ''),
        );
        if (!done.ok) return data<ActionData>({ twoStepError: done.error }, { status: 400 });
        // every other session ended; this tab stays signed in
        return data<ActionData>(
          {
            twoStepMessage:
              'Two-step sign-in is on. You are signed out in every other browser. Keep these recovery codes somewhere safe: each works once, and they are not shown again.',
            recoveryCodes: done.recoveryCodes,
          },
          {
            headers: {
              'Set-Cookie': await renewSessionCookie(request, done.sessionVersion),
              'Cache-Control': 'no-store',
            },
          },
        );
      }
      const off = await turnOffTwoStep(
        membership.orgId,
        user.id,
        membership.role,
        String(form.get('code') ?? ''),
      );
      if (!off.ok) return data<ActionData>({ twoStepError: off.error }, { status: 400 });
      return data<ActionData>({ twoStepMessage: 'Two-step sign-in is off.' });
    } catch (error) {
      if (error instanceof TotpKeyMissing) {
        return data<ActionData>({ twoStepError: KEY_MISSING }, { status: 503 });
      }
      throw error;
    }
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
  const { user, role, tokens, activeTokens, lifetimes, twoStep } = loaderData;
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
          Two-step sign-in
        </h2>
        {twoStep.mustSetUp && (
          <div className="mb-3">
            <Alert>
              Your organisation asks admins and project managers to use two-step sign-in. Set it up
              here to get to the rest of the app.
            </Alert>
          </div>
        )}
        {twoStep.recoveryUsed && (
          <div className="mb-3">
            <Alert tone="info">
              You signed in with a recovery code. {twoStep.recoveryCodesLeft} left.
              {twoStep.recoveryCodesLeft <= 3 &&
                ' When they run out, an admin can reset your second step.'}
            </Alert>
          </div>
        )}
        {result?.twoStepMessage && (
          <div className="mb-3">
            <Alert tone="success">{result.twoStepMessage}</Alert>
          </div>
        )}
        {result?.recoveryCodes && (
          <ul className="mb-3 grid grid-cols-2 gap-1 rounded bg-slate-50 p-3 font-mono text-sm">
            {result.recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
        {result?.twoStepError && (
          <div className="mb-3">
            <Alert>{result.twoStepError}</Alert>
          </div>
        )}
        {twoStep.enabledAt ? (
          <>
            <p className="mb-3 text-sm text-slate-600">
              On since {formatDateTime(twoStep.enabledAt)}. {twoStep.recoveryCodesLeft} recovery
              code{twoStep.recoveryCodesLeft === 1 ? '' : 's'} left.
            </p>
            {!twoStep.required && (
              <Form method="post" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="intent" value="two-step-off" />
                <Field label="A code from the app, or a recovery code" htmlFor="off-code">
                  <Input id="off-code" name="code" autoComplete="one-time-code" required />
                </Field>
                <Button type="submit" variant="secondary">
                  Turn off
                </Button>
              </Form>
            )}
          </>
        ) : twoStep.setup ? (
          <div className="space-y-3 text-sm">
            <p className="text-slate-600">
              Scan this with an authenticator app, or type the key in by hand. Then type the code it
              shows.
            </p>
            {/* drawn on the server by the qrcode package from the otpauth address */}
            <div
              className="h-44 w-44"
              role="img"
              aria-label="QR code with the two-step key"
              dangerouslySetInnerHTML={{ __html: twoStep.setup.qr }}
            />
            <p>
              Key: <code className="font-mono">{twoStep.setup.secret}</code>
            </p>
            <Form method="post" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="intent" value="two-step-confirm" />
              <Field label="Code from the app" htmlFor="setup-code">
                <Input
                  id="setup-code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                />
              </Field>
              <Button type="submit">Turn on</Button>
            </Form>
          </div>
        ) : (
          <Form method="post" className="space-y-3 text-sm">
            <p className="text-slate-600">
              After your password, sign-in asks for a six-digit code from an app on your phone.
              Turning it on signs you out in every other browser.
            </p>
            <input type="hidden" name="intent" value="two-step-start" />
            <Button type="submit" variant="secondary">
              Set up
            </Button>
          </Form>
        )}
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
