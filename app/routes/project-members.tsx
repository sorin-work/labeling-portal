import { Form } from 'react-router';

import { Badge, Button, Card, EmptyState } from '~/components/ui';
import { requireUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { badRequest } from '~/lib/http';
import { ROLE_LABELS } from '~/lib/permissions';
import { logActivity } from '~/models/activity.server';
import { requireProject } from '~/models/projects.server';

import type { Route } from './+types/project-members';

export function meta() {
  return [{ title: 'Members · Labeling Portal' }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  const [members, orgMembers] = await Promise.all([
    prisma.projectMember.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            memberships: { where: { orgId: project.orgId }, select: { role: true } },
          },
        },
      },
    }),
    prisma.membership.findMany({
      where: { orgId: project.orgId, role: { in: ['ANNOTATOR', 'REVIEWER'] } },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { user: { name: 'asc' } },
    }),
  ]);
  const memberIds = new Set(members.map((m) => m.userId));
  const attempts = await prisma.qualificationAttempt.groupBy({
    by: ['userId'],
    where: { projectId: project.id },
    _count: { _all: true },
    _max: { scorePercent: true },
  });
  return {
    qualificationRequired: project.qualificationRequired,
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.user.memberships[0]?.role ?? 'ANNOTATOR',
      addedAt: m.createdAt,
      qualifiedAt: m.qualifiedAt,
      attempts: attempts.find((a) => a.userId === m.userId)?._count._all ?? 0,
      bestScore: attempts.find((a) => a.userId === m.userId)?._max.scorePercent ?? null,
    })),
    candidates: orgMembers
      .filter((m) => !memberIds.has(m.userId))
      .map((m) => ({ id: m.userId, name: m.user.name, email: m.user.email, role: m.role })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireUser(request);
  const project = await requireProject(current, params.projectId, 'manageProjects');
  const form = await request.formData();
  const intent = form.get('intent');
  const userId = String(form.get('userId') ?? '');

  if (intent === 'add') {
    const membership = await prisma.membership.findUnique({
      where: { orgId_userId: { orgId: project.orgId, userId } },
    });
    if (!membership) throw badRequest('That person is not in this organisation');
    await logActivity({
      projectId: project.id,
      actorId: current.user.id,
      action: 'member.added',
      detail: { userId },
    });
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId } },
      create: { projectId: project.id, userId },
      update: {},
    });
    return { ok: true };
  }
  if (intent === 'reset-qualification') {
    await prisma.$transaction([
      prisma.qualificationAttempt.deleteMany({ where: { projectId: project.id, userId } }),
      prisma.projectMember.updateMany({
        where: { projectId: project.id, userId },
        data: { qualifiedAt: null },
      }),
    ]);
    return { ok: true };
  }
  if (intent === 'remove') {
    await prisma.projectMember.deleteMany({ where: { projectId: project.id, userId } });
    await logActivity({
      projectId: project.id,
      actorId: current.user.id,
      action: 'member.removed',
      detail: { userId },
    });
    return { ok: true };
  }
  throw badRequest('Unknown action');
}

export default function ProjectMembers({ loaderData }: Route.ComponentProps) {
  const { members, candidates, qualificationRequired } = loaderData;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        {members.length === 0 ? (
          <EmptyState title="Nobody on this project yet">
            Add annotators and reviewers so they can see the project.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
            {members.map((member) => (
              <li key={member.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{member.name}</div>
                  <div className="text-xs text-slate-500">{member.email}</div>
                </div>
                {qualificationRequired && member.role === 'ANNOTATOR' && (
                  <span className="text-xs text-slate-500">
                    {member.qualifiedAt
                      ? 'Qualified'
                      : member.attempts
                        ? `${member.attempts} attempt${member.attempts === 1 ? '' : 's'}, best ${member.bestScore}%`
                        : 'Not tested'}
                  </span>
                )}
                {qualificationRequired && member.attempts > 0 && (
                  <Form method="post">
                    <input type="hidden" name="userId" value={member.userId} />
                    <Button
                      name="intent"
                      value="reset-qualification"
                      variant="ghost"
                      className="text-xs"
                    >
                      Reset test
                    </Button>
                  </Form>
                )}
                <Badge tone={member.role === 'REVIEWER' ? 'sky' : 'slate'}>
                  {ROLE_LABELS[member.role]}
                </Badge>
                <Form method="post">
                  <input type="hidden" name="userId" value={member.userId} />
                  <Button name="intent" value="remove" variant="ghost" className="text-rose-600">
                    Remove
                  </Button>
                </Form>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Card className="h-fit">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Add people
        </h2>
        {candidates.length === 0 ? (
          <p className="text-sm text-slate-500">Everyone in the organisation is already here.</p>
        ) : (
          <Form method="post" className="space-y-3">
            <select
              name="userId"
              className="block w-full rounded-md border-0 px-3 py-2 text-sm ring-1 ring-slate-300"
              aria-label="Person to add"
            >
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({ROLE_LABELS[c.role]})
                </option>
              ))}
            </select>
            <Button name="intent" value="add" className="w-full">
              Add to project
            </Button>
          </Form>
        )}
      </Card>
    </div>
  );
}
