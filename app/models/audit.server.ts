import { describeActivity } from '~/domain/activity';
import { requireUser, type CurrentUser } from '~/lib/auth.server';
import { forbidden } from '~/lib/http';
import { can } from '~/lib/permissions';

/** The audit trail is for admins of the organisation, checked on the server for the page and the CSV alike. */
export async function requireAuditor(request: Request): Promise<CurrentUser> {
  const current = await requireUser(request);
  if (!can(current.membership.role, 'viewAudit')) throw forbidden();
  return current;
}

export type AuditRow = {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorName: string;
  action: string;
  projectId: string | null;
  project: { name: string } | null;
  detail: unknown;
};

export function auditLine(row: AuditRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    actor: row.actorName,
    action: row.action,
    project: row.project?.name ?? null,
    projectId: row.projectId,
    text: describeActivity(row.action, row.detail),
  };
}
