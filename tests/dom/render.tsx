import { render } from '@testing-library/react';
import type { ComponentType } from 'react';
import { createRoutesStub } from 'react-router';

import AppLayout from '~/routes/app-layout';

const layoutData = {
  user: { id: 'u1', email: 'ada@example.test', name: 'Ada Admin' },
  role: 'ADMIN' as const,
  orgName: 'Acme Labeling',
  flash: null,
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
}: {
  path: string;
  url: string;
  Component: ComponentType<never>;
  loaderData: unknown;
}) {
  const Stub = createRoutesStub([
    {
      id: 'app',
      Component: AppLayout as ComponentType<never>,
      loader: () => layoutData,
      HydrateFallback: () => null,
      children: [{ path, Component, loader: () => loaderData }],
    },
  ]);
  return render(<Stub initialEntries={[url]} />);
}
