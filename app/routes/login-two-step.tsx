import { data, Form, redirect, useNavigation, useSearchParams } from 'react-router';

import { Alert, Button, Field, Input } from '~/components/ui';
import { getCurrentUser } from '~/lib/auth.server';
import { clientAddress } from '~/lib/client-address.server';
import { prisma } from '~/lib/db.server';
import { twoStepLimiter } from '~/lib/rate-limit.server';
import { safeRedirect } from '~/lib/redirect';
import { createUserSession, pendingSignIn } from '~/lib/session.server';
import { logActivity } from '~/models/activity.server';
import { checkSecondStep } from '~/models/two-step.server';

import type { Route } from './+types/login-two-step';

export function meta() {
  return [{ title: 'Second step · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  if (await getCurrentUser(request)) throw redirect('/');
  if (!(await pendingSignIn(request))) throw redirect('/login');
  return null;
}

type ActionData = { error: string };

/**
 * The second page of a sign-in with two-step on. The cookie holds the
 * pending sign-in from the password page; a right code turns it into a
 * session. Wrong codes are limited per account and client address, so
 * someone guessing elsewhere does not lock the owner out of their own
 * browser (see `clientAddress`).
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const next = safeRedirect(form.get('next'));
  const pending = await pendingSignIn(request);
  if (!pending) throw redirect('/login');
  const user = await prisma.user.findUnique({
    where: { id: pending.userId },
    select: { sessionVersion: true },
  });
  // a password change or "sign out everywhere" since the password was typed
  if (!user || user.sessionVersion !== pending.v) throw redirect('/login');

  const key = `${pending.userId}|${clientAddress(request) ?? 'any'}`;
  const limit = await twoStepLimiter.hit(key);
  if (!limit.allowed) {
    if (limit.justLocked) {
      await logActivity(prisma, {
        orgId: pending.orgId,
        actorId: pending.userId,
        action: 'auth.two_step_locked',
      });
    }
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    return data<ActionData>(
      { error: `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }
  const checked = await checkSecondStep(pending.userId, String(form.get('code') ?? ''));
  if (!checked.ok) {
    const error =
      checked.reason === 'format'
        ? 'Type the six digits from the app, or a recovery code.'
        : checked.reason === 'used'
          ? 'That code was used already. Wait for the next one.'
          : checked.reason === 'key'
            ? 'The second step cannot be checked: the server’s TOTP_KEY changed. Ask an admin to reset it.'
            : 'That code is not right.';
    return data<ActionData>({ error }, { status: 401 });
  }
  await twoStepLimiter.reset(key);
  await logActivity(prisma, {
    orgId: pending.orgId,
    actorId: pending.userId,
    action: 'auth.signed_in',
    detail: { twoStep: checked.method },
  });
  return createUserSession(
    request,
    { userId: pending.userId, orgId: pending.orgId, v: pending.v },
    checked.method === 'recovery' ? '/account?recovery=used' : next,
  );
}

export default function TwoStep({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const result = actionData as ActionData | undefined;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-semibold">Second step</h1>
        <p className="mt-1 text-center text-sm text-slate-600">
          Type the code your authenticator app shows for Labeling Portal.
        </p>
        <Form
          method="post"
          className="mt-8 space-y-4 rounded-lg bg-white p-6 shadow ring-1 ring-slate-200"
        >
          {result?.error && <Alert>{result.error}</Alert>}
          <input type="hidden" name="next" value={searchParams.get('next') ?? ''} />
          <Field
            label="Code"
            htmlFor="code"
            hint="Without the phone, type one of your recovery codes instead."
          >
            <Input id="code" name="code" autoComplete="one-time-code" inputMode="text" required />
          </Field>
          <Button type="submit" className="w-full" disabled={navigation.state !== 'idle'}>
            Sign in
          </Button>
        </Form>
        <p className="mt-4 text-center text-sm">
          <a href="/login" className="text-indigo-700 hover:underline">
            Start again
          </a>
        </p>
      </div>
    </main>
  );
}
