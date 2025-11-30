import { data, Form, redirect, useNavigation } from 'react-router';

import { Alert, Button, Field, Input } from '~/components/ui';
import { authenticate, getCurrentUser } from '~/lib/auth.server';
import { safeRedirect } from '~/lib/redirect';
import { createUserSession } from '~/lib/session.server';

import type { Route } from './+types/login';

export function meta() {
  return [{ title: 'Sign in · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  if (await getCurrentUser(request)) throw redirect('/');
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const email = String(form.get('email') ?? '');
  const password = String(form.get('password') ?? '');
  const next = safeRedirect(form.get('next'));

  if (!email || !password) {
    return data({ error: 'Enter your email and password.', email }, { status: 400 });
  }
  const result = await authenticate(email, password);
  if (!result) {
    return data({ error: 'That email and password do not match.', email }, { status: 401 });
  }
  return createUserSession(
    request,
    { userId: result.user.id, orgId: result.membership.orgId },
    next,
  );
}

export default function Login({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const next =
    typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('next');

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
      </div>
    </main>
  );
}
