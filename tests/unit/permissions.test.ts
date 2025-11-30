import { describe, expect, it } from 'vitest';

import { can } from '~/lib/permissions';

describe('can', () => {
  it('lets admins do everything', () => {
    for (const cap of ['manageUsers', 'manageProjects', 'viewPayouts', 'review'] as const) {
      expect(can('ADMIN', cap)).toBe(true);
    }
  });

  it('keeps people management with admins', () => {
    expect(can('PROJECT_MANAGER', 'manageUsers')).toBe(false);
    expect(can('PROJECT_MANAGER', 'manageProjects')).toBe(true);
  });

  it('limits reviewers and annotators to their own work', () => {
    expect(can('REVIEWER', 'review')).toBe(true);
    expect(can('REVIEWER', 'annotate')).toBe(false);
    expect(can('ANNOTATOR', 'annotate')).toBe(true);
    expect(can('ANNOTATOR', 'review')).toBe(false);
    expect(can('ANNOTATOR', 'viewPayouts')).toBe(false);
  });
});
