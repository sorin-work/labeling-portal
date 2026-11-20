import { useEffect, useRef } from 'react';
import { data, Form, Link, NavLink, Outlet, useLocation } from 'react-router';

import { Flash } from '~/components/flash';

import { cx } from '~/components/ui';
import { beforeSignOut } from '~/components/use-draft-save';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { consumeFlash } from '~/lib/flash.server';
import { can, ROLE_LABELS } from '~/lib/permissions';

import type { Route } from './+types/app-layout';

export async function loader({ request }: Route.LoaderArgs) {
  const { user, membership } = await requireUser(request);
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: membership.orgId },
    select: { name: true },
  });
  const flash = await consumeFlash(request);
  return data(
    { user, role: membership.role, orgName: org.name, flash: flash.message },
    { headers: flash.headers },
  );
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user, role, orgName, flash } = loaderData;
  const links = [
    { to: '/', label: 'Dashboard', show: true },
    { to: '/projects', label: 'Projects', show: true },
    { to: '/my-work', label: 'My work', show: can(role, 'annotate') },
    { to: '/payouts', label: 'Payouts', show: can(role, 'viewPayouts') },
    { to: '/people', label: 'People', show: can(role, 'manageUsers') },
  ].filter((link) => link.show);

  // A new page puts focus at the start of its content, as a page load would,
  // unless the page has put it somewhere itself (the work page puts it on the
  // next task). Changes of the query string (sorting, paging) leave it alone.
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const firstPath = useRef(location.pathname);
  useEffect(() => {
    if (location.pathname === firstPath.current) return;
    firstPath.current = location.pathname;
    const main = mainRef.current;
    const at = document.activeElement;
    if (!main || (at && at !== document.body && main.contains(at))) return;
    main.focus({ preventScroll: true });
  }, [location.pathname]);

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow"
      >
        Skip to content
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:gap-6">
          <details className="relative sm:hidden">
            <summary className="cursor-pointer list-none rounded-md p-1.5 text-slate-600 hover:bg-slate-100">
              <span className="sr-only">Menu</span>
              <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor" aria-hidden>
                <path d="M3 5h14v2H3zm0 4h14v2H3zm0 4h14v2H3z" />
              </svg>
            </summary>
            <nav className="absolute left-0 z-20 mt-2 flex w-48 flex-col rounded-md bg-white p-1 shadow-lg ring-1 ring-slate-200">
              {links.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.to === '/'}
                  className="rounded px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
                >
                  {link.label}
                </NavLink>
              ))}
            </nav>
          </details>
          <div>
            <div className="text-sm font-semibold text-indigo-700">Labeling Portal</div>
            <div className="text-xs text-slate-500">{orgName}</div>
          </div>
          <nav className="hidden flex-1 gap-1 sm:flex" aria-label="Main">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.to === '/'}
                className={({ isActive }) =>
                  cx(
                    'rounded-md px-3 py-1.5 text-sm font-medium',
                    isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100',
                  )
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <Link to="/account" className="ml-auto text-right hover:opacity-80 sm:ml-0">
            <div className="text-sm font-medium">{user.name}</div>
            <div className="text-xs text-slate-500">{ROLE_LABELS[role]}</div>
          </Link>
          {/* saves the open task, then empties what this tab keeps for it */}
          <Form method="post" action="/logout" onSubmit={beforeSignOut}>
            <button className="text-sm text-slate-500 hover:text-slate-800">Sign out</button>
          </Form>
        </div>
      </header>
      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className="mx-auto max-w-6xl px-4 py-8 focus:outline-none"
      >
        <Outlet />
      </main>
      <Flash message={flash} />
    </div>
  );
}
