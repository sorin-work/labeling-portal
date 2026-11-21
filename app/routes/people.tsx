import type { Role } from '@prisma/client';
import { data, Form, useNavigation } from 'react-router';

import { Alert, Badge, Button, Card, Field, Input, PageHeader } from '~/components/ui';
import { requireRole } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { formatDate } from '~/lib/format';
import { fieldErrors } from '~/lib/http';
import { ROLE_LABELS, ROLES } from '~/lib/permissions';
import { listActiveApiTokens, revokeApiTokenOf } from '~/models/api-tokens.server';
import { resetTwoStep, setTwoStepRule } from '~/models/two-step.server';
import {
  addPerson,
  changeRole,
  endSessions,
  listPeople,
  newPersonSchema,
  removePerson,
  setPassword,
} from '~/models/people.server';

import type { Route } from './+types/people';

export function meta() {
  return [{ title: 'People · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user, membership } = await requireRole(request, ['ADMIN']);
  const [people, org] = await Promise.all([
    listPeople(membership.orgId),
    prisma.organization.findUniqueOrThrow({
      where: { id: membership.orgId },
      select: { twoStepRequired: true },
    }),
  ]);
  return {
    me: user.id,
    twoStepRequired: org.twoStepRequired,
    people: people.map(({ user: { totpEnabledAt, ...person }, ...m }) => ({
      ...person,
      twoStep: totpEnabledAt !== null,
      role: m.role,
      joinedAt: m.createdAt,
    })),
  };
}

type ActionData = {
  errors?: Record<string, string>;
  error?: string;
  message?: string;
  /** after their sessions ended: the person's API tokens that still work */
  tokens?: {
    userId: string;
    name: string;
    list: Array<{ id: string; name: string; prefix: string }>;
  };
};

/** The tokens a password change or "End sessions" left working, to show with a way to revoke them. */
async function stillWorking(orgId: string, userId: string): Promise<ActionData['tokens']> {
  const list = await listActiveApiTokens(orgId, userId);
  if (list.length === 0) return undefined;
  const person = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { name: true },
  });
  return {
    userId,
    name: person.name,
    list: list.map((t) => ({ id: t.id, name: t.name, prefix: t.prefix })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, membership } = await requireRole(request, ['ADMIN']);
  const form = await request.formData();
  const intent = form.get('intent');
  const userId = String(form.get('userId') ?? '');

  if (intent === 'add') {
    const parsed = newPersonSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success) {
      return data<ActionData>({ errors: fieldErrors(parsed.error.issues) }, { status: 400 });
    }
    const result = await addPerson(membership.orgId, user.id, parsed.data);
    if (!result.ok) return data<ActionData>({ errors: { email: result.error } }, { status: 400 });
    return data<ActionData>({ message: `${parsed.data.name} was added.` });
  }
  if (intent === 'role') {
    const role = String(form.get('role'));
    if (!ROLES.includes(role as Role))
      return data<ActionData>({ error: 'Unknown role.' }, { status: 400 });
    const result = await changeRole(membership.orgId, user.id, userId, role as Role);
    if (!result.ok) return data<ActionData>({ error: result.error }, { status: 400 });
    return data<ActionData>({ message: 'Role updated.' });
  }
  if ((intent === 'password' || intent === 'sessions') && userId === user.id) {
    return data<ActionData>(
      {
        error:
          intent === 'password'
            ? 'Change your own password on your account page.'
            : 'Sign yourself out everywhere from your account page.',
      },
      { status: 400 },
    );
  }
  if (intent === 'password') {
    const result = await setPassword(
      membership.orgId,
      user.id,
      userId,
      String(form.get('password') ?? ''),
    );
    if (!result.ok) return data<ActionData>({ error: result.error }, { status: 400 });
    return data<ActionData>({
      message: 'Password updated and every session they had ended. Share it with them privately.',
      tokens: await stillWorking(membership.orgId, userId),
    });
  }
  if (intent === 'sessions') {
    const result = await endSessions(membership.orgId, user.id, userId);
    if (!result.ok) return data<ActionData>({ error: result.error }, { status: 400 });
    return data<ActionData>({
      message:
        'Their sessions ended, in this organisation and any other they are in. Every browser they were signed in on asks them to sign in.',
      tokens: await stillWorking(membership.orgId, userId),
    });
  }
  if (intent === 'token-revoke') {
    const revoked = await revokeApiTokenOf(
      membership.orgId,
      user.id,
      userId,
      String(form.get('tokenId') ?? ''),
    );
    if (!revoked.ok)
      return data<ActionData>(
        { error: 'That token was not found for this person, or it is already revoked.' },
        { status: 404 },
      );
    return data<ActionData>({
      message: 'Token revoked.',
      tokens: await stillWorking(membership.orgId, userId),
    });
  }
  if (intent === 'two-step-reset') {
    const result = await resetTwoStep(membership.orgId, user.id, userId);
    if (!result.ok) return data<ActionData>({ error: result.error }, { status: 400 });
    return data<ActionData>({
      message:
        'Their two-step sign-in was reset and their sessions ended. They sign in with the password and set it up again.',
    });
  }
  if (intent === 'two-step-rule') {
    const required = form.get('required') === 'on';
    const result = await setTwoStepRule(membership.orgId, user.id, required);
    if (!result.ok) return data<ActionData>({ error: result.error }, { status: 400 });
    return data<ActionData>({
      message: required
        ? 'Admins and project managers now need two-step sign-in. Those without it are asked to set it up.'
        : 'Two-step sign-in is no longer required.',
    });
  }
  if (intent === 'remove') {
    const result = await removePerson(membership.orgId, user.id, userId);
    if (!result.ok) return data<ActionData>({ error: result.error }, { status: 400 });
    return data<ActionData>({ message: 'Removed from the organisation.' });
  }
  return data<ActionData>({ error: 'Unknown action.' }, { status: 400 });
}

export default function People({ loaderData, actionData }: Route.ComponentProps) {
  const { people, me, twoStepRequired } = loaderData;
  const result = actionData as ActionData | undefined;
  const navigation = useNavigation();

  return (
    <div>
      <PageHeader title="People" subtitle={`${people.length} people in this organisation`} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {result?.message && <Alert tone="success">{result.message}</Alert>}
          {result?.error && <Alert>{result.error}</Alert>}
          {result?.tokens && (
            <Alert tone="info">
              <div>
                API tokens are not sessions. These of {result.tokens.name} still work. Revoke the
                ones that may be in the wrong hands; a script that uses one stops working.
              </div>
              <ul className="mt-2 space-y-1">
                {result.tokens.list.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      {t.name} <code>{t.prefix}…</code>
                    </span>
                    <Form method="post">
                      <input type="hidden" name="userId" value={result.tokens!.userId} />
                      <input type="hidden" name="tokenId" value={t.id} />
                      <Button name="intent" value="token-revoke" variant="secondary">
                        Revoke
                      </Button>
                    </Form>
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          <ul className="divide-y divide-slate-200 rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
            {people.map((person) => (
              <li key={person.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {person.name} {person.id === me && <Badge tone="indigo">You</Badge>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {person.email} · joined {formatDate(person.joinedAt)}
                    {person.twoStep ? ' · two-step on' : ''}
                  </div>
                </div>
                {person.id === me ? (
                  <span className="text-sm text-slate-500">{ROLE_LABELS[person.role]}</span>
                ) : (
                  <>
                    <Form method="post" className="flex items-center gap-2">
                      <input type="hidden" name="userId" value={person.id} />
                      <select
                        name="role"
                        defaultValue={person.role}
                        aria-label={`Role for ${person.name}`}
                        className="rounded-md border-0 py-1.5 pl-2 pr-8 text-sm ring-1 ring-slate-300"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                      <Button name="intent" value="role" variant="secondary">
                        Save
                      </Button>
                    </Form>
                    <Form
                      method="post"
                      onSubmit={(event) => {
                        if (!confirm(`Remove ${person.name} from the organisation?`))
                          event.preventDefault();
                      }}
                    >
                      <input type="hidden" name="userId" value={person.id} />
                      <Button
                        name="intent"
                        value="remove"
                        variant="ghost"
                        className="text-rose-700"
                      >
                        Remove
                      </Button>
                    </Form>
                    <Form
                      method="post"
                      onSubmit={(event) => {
                        if (
                          !confirm(
                            `Sign ${person.name} out in every browser? This also signs them out of any other organisation they are in.`,
                          )
                        )
                          event.preventDefault();
                      }}
                    >
                      <input type="hidden" name="userId" value={person.id} />
                      <Button name="intent" value="sessions" variant="ghost">
                        End sessions
                      </Button>
                    </Form>
                    {person.twoStep && (
                      <Form
                        method="post"
                        onSubmit={(event) => {
                          if (
                            !confirm(
                              `Reset the two-step sign-in of ${person.name}? Their sessions end, and they sign in with the password alone until they set it up again.`,
                            )
                          )
                            event.preventDefault();
                        }}
                      >
                        <input type="hidden" name="userId" value={person.id} />
                        <Button name="intent" value="two-step-reset" variant="ghost">
                          Reset two-step
                        </Button>
                      </Form>
                    )}
                    <details className="w-full text-sm">
                      <summary className="cursor-pointer text-xs text-slate-500">
                        Set a new password
                      </summary>
                      <Form method="post" className="mt-2 flex gap-2">
                        <input type="hidden" name="userId" value={person.id} />
                        <Input
                          name="password"
                          type="text"
                          autoComplete="off"
                          placeholder="New password"
                          aria-label={`New password for ${person.name}`}
                          className="max-w-xs"
                        />
                        <Button name="intent" value="password" variant="secondary">
                          Set
                        </Button>
                      </Form>
                    </details>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="h-fit space-y-6">
          <Card>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Two-step sign-in
            </h2>
            <Form method="post" className="space-y-3 text-sm">
              <label className="flex items-start gap-2">
                <input type="checkbox" name="required" defaultChecked={twoStepRequired} />
                <span>
                  Require it for admins and project managers. Those without it can only open their
                  account page until they set it up. API tokens are not affected.
                </span>
              </label>
              <Button name="intent" value="two-step-rule" variant="secondary">
                Save
              </Button>
            </Form>
          </Card>
          <Card>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Add a person
            </h2>
            <Form method="post" className="space-y-3">
              <Field label="Name" htmlFor="name" error={result?.errors?.name}>
                <Input id="name" name="name" required />
              </Field>
              <Field label="Email" htmlFor="email" error={result?.errors?.email}>
                <Input id="email" name="email" type="email" required />
              </Field>
              <Field label="Role" htmlFor="role">
                <select
                  id="role"
                  name="role"
                  defaultValue="ANNOTATOR"
                  className="block w-full rounded-md border-0 px-3 py-2 text-sm ring-1 ring-slate-300"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Temporary password"
                htmlFor="password"
                error={result?.errors?.password}
                hint="Share it privately; they can change it after signing in."
              >
                <Input id="password" name="password" type="text" autoComplete="off" required />
              </Field>
              <Button
                name="intent"
                value="add"
                className="w-full"
                disabled={navigation.state !== 'idle'}
              >
                Add person
              </Button>
            </Form>
          </Card>
        </div>
      </div>
    </div>
  );
}
