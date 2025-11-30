import { Form } from 'react-router';

import { Button } from '~/components/ui';
import { requireUser } from '~/lib/auth.server';

import type { Route } from './+types/home';

export function meta() {
  return [{ title: 'Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user, membership } = await requireUser(request);
  return { user, role: membership.role };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold">Hello, {loaderData.user.name}</h1>
      <p className="mt-2 text-slate-600">Signed in as {loaderData.role.toLowerCase()}.</p>
      <Form method="post" action="/logout" className="mt-6">
        <Button variant="secondary">Sign out</Button>
      </Form>
    </main>
  );
}
