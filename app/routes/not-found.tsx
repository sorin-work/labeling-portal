import { Link } from 'react-router';

export function meta() {
  return [{ title: 'Page not found · Labeling Portal' }];
}

export function loader() {
  throw new Response('Not found', { status: 404 });
}

export default function NotFound() {
  return null;
}

export function ErrorBoundary() {
  return (
    <main className="mx-auto max-w-xl px-4 py-24 text-center">
      <p className="text-sm font-semibold text-indigo-600">404</p>
      <h1 className="mt-2 text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-slate-600">The page you asked for does not exist or was moved.</p>
      <Link
        to="/"
        className="mt-6 inline-block text-sm font-medium text-indigo-700 hover:underline"
      >
        Back to the dashboard
      </Link>
    </main>
  );
}
