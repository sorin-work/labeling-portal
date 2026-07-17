import type { Role } from '@prisma/client';
import { data, Form, useNavigation } from 'react-router';

import { Alert, Badge, Button, Card, Field, Input, PageHeader } from '~/components/ui';
import { requireRole } from '~/lib/auth.server';
import { formatDate } from '~/lib/format';
import { fieldErrors } from '~/lib/http';
import { ROLE_LABELS, ROLES } from '~/lib/permissions';
import {
  addPerson,
  changeRole,
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
  const people = await listPeople(membership.orgId);
  return {
    me: user.id,
    people: people.map((m) => ({ ...m.user, role: m.role, joinedAt: m.createdAt })),
  };
}

type ActionData = { errors?: Record<string, string>; error?: string; message?: string };

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
    const result = await addPerson(membership.orgId, parsed.data);
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
  if (intent === 'password') {
    const result = await setPassword(membership.orgId, userId, String(form.get('password') ?? ''));
    if (!result.ok) return data<ActionData>({ error: result.error }, { status: 400 });
    return data<ActionData>({ message: 'Password updated. Share it with them privately.' });
  }
  if (intent === 'remove') {
    const result = await removePerson(membership.orgId, user.id, userId);
    if (!result.ok) return data<ActionData>({ error: result.error }, { status: 400 });
    return data<ActionData>({ message: 'Removed from the organisation.' });
  }
  return data<ActionData>({ error: 'Unknown action.' }, { status: 400 });
}

export default function People({ loaderData, actionData }: Route.ComponentProps) {
  const { people, me } = loaderData;
  const result = actionData as ActionData | undefined;
  const navigation = useNavigation();

  return (
    <div>
      <PageHeader title="People" subtitle={`${people.length} people in this organisation`} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {result?.message && <Alert tone="success">{result.message}</Alert>}
          {result?.error && <Alert>{result.error}</Alert>}
          <ul className="divide-y divide-slate-200 rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
            {people.map((person) => (
              <li key={person.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {person.name} {person.id === me && <Badge tone="indigo">You</Badge>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {person.email} · joined {formatDate(person.joinedAt)}
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
                        className="text-rose-600"
                      >
                        Remove
                      </Button>
                    </Form>
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
        <Card className="h-fit">
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
  );
}
