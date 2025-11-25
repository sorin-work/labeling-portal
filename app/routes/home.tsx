import type { Route } from './+types/home';

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Labeling Portal' }];
}

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold">Labeling Portal</h1>
      <p className="mt-2 text-slate-600">
        Projects, task queues, review and payouts for labeling teams.
      </p>
    </main>
  );
}
