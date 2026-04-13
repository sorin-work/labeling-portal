import { Form, Link, NavLink, Outlet } from 'react-router';

import { cx } from '~/components/ui';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { can, ROLE_LABELS } from '~/lib/permissions';

import type { Route } from './+types/app-layout';

export async function loader({ request }: Route.LoaderArgs) {
  const { user, membership } = await requireUser(request);
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: membership.orgId },
    select: { name: true },
  });
  return { user, role: membership.role, orgName: org.name };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user, role, orgName } = loaderData;
  const links = [
    { to: '/', label: 'Dashboard', show: true },
    { to: '/projects', label: 'Projects', show: true },
    { to: '/my-work', label: 'My work', show: can(role, 'annotate') },
    { to: '/payouts', label: 'Payouts', show: can(role, 'viewPayouts') },
    { to: '/people', label: 'People', show: can(role, 'manageUsers') },
  ].filter((link) => link.show);

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-indigo-700">Labeling Portal</div>
            <div className="text-xs text-slate-500">{orgName}</div>
          </div>
          <nav className="flex flex-1 gap-1">
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
          <Link to="/account" className="text-right hover:opacity-80">
            <div className="text-sm font-medium">{user.name}</div>
            <div className="text-xs text-slate-500">{ROLE_LABELS[role]}</div>
          </Link>
          <Form method="post" action="/logout">
            <button className="text-sm text-slate-500 hover:text-slate-800">Sign out</button>
          </Form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
