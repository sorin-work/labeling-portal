import { Form, Link } from 'react-router';

import { Badge, Button, Card, EmptyState, StatCard } from '~/components/ui';
import { startOfUtcDay } from '~/domain/daily-limit';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { formatDateTime, KIND_NAMES, STATUS_TONES, titleCase } from '~/lib/format';
import { can } from '~/lib/permissions';
import { myStats, reviewerStats } from '~/models/annotator-stats.server';
import { backupStatus, needsAttention } from '~/models/attention.server';
import { listProjects } from '~/models/projects.server';
import { countAvailable } from '~/models/queue.server';

import type { Route } from './+types/dashboard';

export function meta() {
  return [{ title: 'Dashboard · Labeling Portal' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const { user, membership } = current;
  const projects = await listProjects(current);
  const canAnnotate = can(membership.role, 'annotate');
  const now = new Date();

  const [available, submittedToday, active] = await Promise.all([
    canAnnotate
      ? countAvailable(
          projects.filter((p) => p.status === 'ACTIVE').map((p) => p.id),
          user.id,
          now,
        )
      : Promise.resolve(new Map<string, number>()),
    prisma.assignment.count({
      where: { userId: user.id, status: 'SUBMITTED', submittedAt: { gte: startOfUtcDay(now) } },
    }),
    prisma.assignment.findMany({
      where: { userId: user.id, status: 'ACTIVE', expiresAt: { gt: now } },
      select: { id: true, project: { select: { name: true } } },
    }),
  ]);

  const stats = canAnnotate ? await myStats(user.id, 30, now) : null;
  const reviewing = membership.role === 'REVIEWER' ? await reviewerStats(user.id, 7, now) : null;
  // a dump holds every organisation, so only admins hear about it
  const backups = membership.role === 'ADMIN' ? await backupStatus(now) : null;
  const attention = can(membership.role, 'manageProjects')
    ? [...(await needsAttention(membership.orgId, now)), ...(backups?.items ?? [])]
    : null;

  return {
    user,
    role: membership.role,
    canAnnotate,
    stats,
    attention,
    lastBackup: backups?.lastGood ?? null,
    reviewing,
    submittedToday,
    active: active.map((a) => ({ id: a.id, projectName: a.project.name })),
    projects: projects
      .filter((p) => p.status !== 'ARCHIVED')
      .map((p) => ({ ...p, available: available.get(p.id) ?? 0 })),
  };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const {
    user,
    canAnnotate,
    submittedToday,
    active,
    projects,
    stats,
    attention,
    lastBackup,
    reviewing,
  } = loaderData;
  const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Welcome back, {user.name}</h1>
        {canAnnotate && (
          <p className="mt-1 text-slate-600">
            You have submitted {submittedToday} task{submittedToday === 1 ? '' : 's'} today.
          </p>
        )}
      </div>

      {stats && stats.submitted > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Last 30 days
          </h2>
          <div className="grid gap-4 sm:grid-cols-4">
            {[
              { label: 'Submitted', value: String(stats.submitted) },
              {
                label: 'Accepted',
                value: pct(stats.acceptanceRate),
                hint: `${stats.sentBack} sent back`,
              },
              { label: 'Gold accuracy', value: pct(stats.goldAccuracy) },
              { label: 'Active time', value: `${stats.hours} h` },
            ].map((s) => (
              <StatCard key={s.label} label={s.label} value={s.value} hint={s.hint} />
            ))}
          </div>
        </section>
      )}

      {reviewing && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Your reviews, last 7 days
          </h2>
          <div className="grid gap-4 sm:grid-cols-5">
            <StatCard label="Reviewed" value={reviewing.reviews} />
            <StatCard label="Sent back" value={reviewing.sentBack} />
            <StatCard label="Fixed" value={reviewing.fixed} />
            <StatCard
              label="Overturned"
              value={reviewing.overturned}
              hint="After a dispute, not counted in the rest"
            />
            <StatCard label="Average score given" value={reviewing.avgScore ?? '–'} />
          </div>
        </section>
      )}

      {attention && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Needs attention
          </h2>
          {attention.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nothing right now. Reviews are on time and gold scores look fine.
            </p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {attention.map((item) => {
                switch (item.kind) {
                  case 'stale-reviews':
                    return (
                      <li key={`s-${item.projectId}`}>
                        <Link
                          to={`/projects/${item.projectId}/review`}
                          className="text-indigo-700 hover:underline"
                        >
                          {item.projectName}
                        </Link>
                        : {item.count} submission{item.count === 1 ? '' : 's'} waiting for review
                        for more than a day
                      </li>
                    );
                  case 'low-gold':
                    return (
                      <li key={`g-${item.projectId}-${item.userName}`}>
                        <Link
                          to={`/projects/${item.projectId}/quality`}
                          className="text-indigo-700 hover:underline"
                        >
                          {item.projectName}
                        </Link>
                        : {item.userName} matches gold answers {Math.round(item.accuracy * 100)}% of
                        the time ({item.attempts} gold tasks)
                      </li>
                    );
                  case 'backup-failed':
                    return (
                      <li key="backup-failed">
                        The last dump failed, {formatDateTime(item.at)}
                        {item.message ? `: ${item.message}` : '. The backup service log says why.'}
                      </li>
                    );
                  case 'backup-late':
                    return (
                      <li key="backup-late">
                        {item.hours === null
                          ? 'No dump has worked yet.'
                          : `No dump for ${item.hours} hours.`}
                      </li>
                    );
                }
              })}
            </ul>
          )}
          {lastBackup && (
            <p className="mt-3 text-xs text-slate-500">
              Last good dump: {lastBackup.file ?? 'no file name'},{' '}
              {formatDateTime(lastBackup.finishedAt)}. A dump is recorded after it is made, so it is
              in the next dump and not its own. After a restore this list ends at the dump before
              the one that was restored.
            </p>
          )}
        </Card>
      )}

      {active.length > 0 && (
        <Card className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            In progress
          </h2>
          {active.map((a) => (
            <div key={a.id} className="flex items-center justify-between">
              <span>{a.projectName}</span>
              <Link to={`/work/${a.id}`}>
                <Button variant="secondary">Continue</Button>
              </Link>
            </div>
          ))}
        </Card>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          {canAnnotate ? 'Your projects' : 'Projects'}
        </h2>
        {projects.length === 0 ? (
          <EmptyState title="Nothing here yet">
            {canAnnotate
              ? 'A project manager needs to add you to a project before you can start.'
              : 'Projects you can see will show up here.'}
          </EmptyState>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {projects.map((project) => (
              <Card key={project.id} className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    to={`/projects/${project.id}`}
                    className="font-medium hover:text-indigo-700"
                  >
                    {project.name}
                  </Link>
                  <Badge tone={STATUS_TONES[project.status]}>{titleCase(project.status)}</Badge>
                </div>
                <p className="text-sm text-slate-500">{KIND_NAMES[project.kind]}</p>
                {canAnnotate && project.status === 'ACTIVE' && (
                  <div className="mt-auto flex items-center justify-between">
                    <span className="text-sm text-slate-600">
                      {project.available} task{project.available === 1 ? '' : 's'} available
                    </span>
                    <Form method="post" action={`/projects/${project.id}/work`}>
                      <Button disabled={project.available === 0}>Start</Button>
                    </Form>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
