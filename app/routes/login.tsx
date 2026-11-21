import { data, Form, redirect, useNavigation, useSearchParams } from 'react-router';

import { Alert, Button, Field, Input } from '~/components/ui';
import { authenticate, getCurrentUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { clientAddress } from '~/lib/client-address.server';
import { signInDelayMs, signInKey } from '~/domain/sign-in-delay';
import {
  BUSY_EMAIL_TRIES,
  loginEmailLimiter,
  loginLimiter,
  signInPause,
} from '~/lib/rate-limit.server';
import { safeRedirect } from '~/lib/redirect';
import { createUserSession, startPendingSignIn } from '~/lib/session.server';
import { logActivity } from '~/models/activity.server';

import type { Route } from './+types/login';

export function meta() {
  return [{ title: 'Sign in · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  if (await getCurrentUser(request)) throw redirect('/');
  return { showDemoLogins: process.env.SHOW_DEMO_LOGINS === 'true' };
}

const DEMO_LOGINS = [
  ['admin@example.com', 'Admin'],
  ['pm@example.com', 'Project manager'],
  ['reviewer@example.com', 'Reviewer'],
  ['annotator@example.com', 'Annotator'],
];

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const email = String(form.get('email') ?? '');
  const password = String(form.get('password') ?? '');
  const next = safeRedirect(form.get('next'));

  // no address is longer than 254 characters; a longer one is not looked up
  if (!email || !password || email.length > MAX_EMAIL_LENGTH) {
    return data(
      { error: 'Enter your email and password.', email: email.slice(0, MAX_EMAIL_LENGTH) },
      { status: 400 },
    );
  }
  const key = signInKey(email);
  const address = clientAddress(request);
  // the try is reserved before the password is checked, in one statement, so
  // a burst of parallel requests gets no more tries than one at a time; a
  // right password gives its try back
  const reserved = await loginLimiter.hit(key, Date.now(), address ?? 'any');
  if (address === null) {
    // all clients look alike, so nobody is refused, which would lock the
    // owner out too: wrong attempts are slowed down instead
    await signInPause.wait(signInDelayMs(reserved.count));
  } else {
    // per email and address; while many places guess at an email, each
    // address gets fewer tries of its own
    const everywhere = await loginEmailLimiter.peek(key);
    const tries =
      everywhere.count >= loginEmailLimiter.limitPerWindow
        ? BUSY_EMAIL_TRIES
        : loginLimiter.limitPerWindow;
    if (reserved.count > tries) {
      // recorded once, by the first refused try of this email and address
      if (reserved.count === tries + 1) await recordLockout(key);
      return tooMany(email, reserved.retryAfterSeconds || 15 * 60);
    }
  }
  const result = await authenticate(email, password);
  if (!result) {
    await loginEmailLimiter.hit(key);
    return data({ error: 'That email and password do not match.', email }, { status: 401 });
  }
  await loginLimiter.giveBack(key, address ?? 'any');
  const signingIn = {
    userId: result.user.id,
    orgId: result.membership.orgId,
    v: result.user.sessionVersion,
  };
  // the password was right; with a second step on, the cookie only says who
  // is signing in, and the sign-in is recorded once the code is right
  if (result.user.totpEnabledAt) return startPendingSignIn(request, signingIn, next);
  await logActivity(prisma, {
    orgId: result.membership.orgId,
    actorId: result.user.id,
    action: 'auth.signed_in',
  });
  return createUserSession(request, signingIn, next);
}

const MAX_EMAIL_LENGTH = 254;

function tooMany(email: string, retryAfterSeconds: number) {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return data(
    {
      error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      email,
    },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

/**
 * A lockout is recorded for an account that exists, in the organisation it
 * signs in to, with the account as the actor. An email nobody has records
 * nothing, so the sign-in form is not a way for anyone to write to the log.
 */
async function recordLockout(email: string) {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { memberships: { orderBy: { createdAt: 'asc' }, take: 1 } },
  });
  const membership = user?.memberships[0];
  if (!user || !membership) return;
  await logActivity(prisma, { orgId: membership.orgId, actorId: user.id, action: 'auth.locked' });
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const next = searchParams.get('next');

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-semibold">Sign in</h1>
        <p className="mt-1 text-center text-sm text-slate-600">Labeling Portal</p>
        <Form
          method="post"
          className="mt-8 space-y-4 rounded-lg bg-white p-6 shadow ring-1 ring-slate-200"
        >
          {actionData?.error && <Alert>{actionData.error}</Alert>}
          <input type="hidden" name="next" value={next ?? ''} />
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={actionData?.email}
              required
            />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <Button type="submit" className="w-full" disabled={navigation.state !== 'idle'}>
            Sign in
          </Button>
        </Form>
        {loaderData?.showDemoLogins && (
          <div className="mt-6 rounded-lg bg-white p-4 text-sm ring-1 ring-slate-200">
            <p className="mb-2 font-medium">Demo accounts</p>
            <p className="mb-2 text-slate-500">
              Password <code className="font-mono">labeling-demo</code> for all of them.
            </p>
            <ul className="space-y-1">
              {DEMO_LOGINS.map(([email, role]) => (
                <li key={email} className="flex justify-between">
                  <code className="font-mono text-xs">{email}</code>
                  <span className="text-slate-500">{role}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
