import type { Role } from '@prisma/client';

export type Capability =
  | 'manageUsers'
  | 'manageProjects'
  | 'viewPayouts'
  | 'viewQuality'
  | 'exportLabels'
  | 'review'
  | 'annotate';

const CAPABILITIES: Record<Role, readonly Capability[]> = {
  ADMIN: [
    'manageUsers',
    'manageProjects',
    'viewPayouts',
    'viewQuality',
    'exportLabels',
    'review',
    'annotate',
  ],
  PROJECT_MANAGER: ['manageProjects', 'viewPayouts', 'viewQuality', 'exportLabels', 'review'],
  REVIEWER: ['viewQuality', 'review'],
  ANNOTATOR: ['annotate'],
};

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITIES[role].includes(capability);
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  PROJECT_MANAGER: 'Project manager',
  REVIEWER: 'Reviewer',
  ANNOTATOR: 'Annotator',
};
