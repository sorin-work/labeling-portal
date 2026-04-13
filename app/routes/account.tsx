import { data, Form } from 'react-router';

import { Alert, Button, Card, Field, Input, PageHeader } from '~/components/ui';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '~/lib/password.server';
import { ROLE_LABELS } from '~/lib/permissions';

import type { Route } from './+types/account';

export function meta() {
  return [{ title: 'Account · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user, membership } = await requireUser(request);
  return { user, role: membership.role };
}

type ActionData = { error?: string; field?: string; message?: string };

export async function action({ request }: Route.ActionArgs) {
  const { user } = await requireUser(request);
  const form = await request.formData();
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
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(next) },
  });
  return data<ActionData>({ message: 'Password changed.' });
}

export default function Account({ loaderData, actionData }: Route.ComponentProps) {
  const { user, role } = loaderData;
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
          <Button type="submit">Change password</Button>
        </Form>
      </Card>
    </div>
  );
}
