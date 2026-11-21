import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createRoutesStub } from 'react-router';

import AppLayout from '~/routes/app-layout';
import ProjectLayout from '~/routes/project-layout';

const projectData = {
  pendingReviews: 2,
  openDisputes: 0,
  project: { id: 'p1', name: 'Reviews', status: 'ACTIVE', kind: 'NER' },
  can: { manage: true, review: true, quality: true, export: true },
};

const layoutData = {
  user: { id: 'u1', email: 'ada@example.test', name: 'Ada Admin' },
  role: 'ADMIN' as const,
  orgName: 'Acme Labeling',
  flash: null,
  unread: 2,
};

/**
 * Renders a route module's page inside the real app layout (header, skip
 * link, `<main>`), with the loader data the page would get. `path` is the
 * route pattern and `url` the address to open.
 */
export function renderPage({
  path,
  url,
  Component,
  loaderData,
  action,
  more = [],
  inProject = false,
}: {
  path: string;
  url: string;
  /** the route module's default export */
  Component: unknown;
  /** the loader's data, or a function of the route's params that returns it */
  loaderData: unknown;
  action?: (args: { request: Request }) => unknown;
  /** further pages next to it, to navigate to */
  more?: Array<{ path: string; Component: () => ReactNode }>;
  /** inside the project layout (its heading and tabs), as `/projects/:projectId/...` pages are */
  inProject?: boolean;
}) {
  const loader =
    typeof loaderData === 'function'
      ? ({ params }: { params: Record<string, string | undefined> }) => loaderData(params)
      : () => loaderData;
  const Stub = createRoutesStub([
    {
      id: 'app',
      Component: AppLayout as never,
      loader: () => layoutData,
      HydrateFallback: () => null,
      children: inProject
        ? [
            {
              path: '/projects/:projectId',
              Component: ProjectLayout as never,
              loader: () => projectData,
              children: [{ path, Component: Component as never, loader, action }],
            },
          ]
        : [{ path, Component: Component as never, loader, action }, ...more],
    },
  ]);
  return render(<Stub initialEntries={[url]} />);
}
