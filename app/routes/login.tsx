import { data, Form, redirect, useNavigation, useSearchParams } from 'react-router';

import { Alert, Button, Field, Input } from '~/components/ui';
import { authenticate, getCurrentUser } from '~/lib/auth.server';
import { loginLimiter } from '~/lib/rate-limit.server';
import { safeRedirect } from '~/lib/redirect';
import { createUserSession } from '~/lib/session.server';

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

  if (!email || !password) {
    return data({ error: 'Enter your email and password.', email }, { status: 400 });
  }
  const key = email.trim().toLowerCase();
  const limit = loginLimiter.hit(key);
  if (!limit.allowed) {
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    return data(
      {
        error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        email,
      },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }
  const result = await authenticate(email, password);
  if (!result) {
    return data({ error: 'That email and password do not match.', email }, { status: 401 });
  }
  loginLimiter.reset(key);
  return createUserSession(
    request,
    { userId: result.user.id, orgId: result.membership.orgId },
    next,
  );
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
