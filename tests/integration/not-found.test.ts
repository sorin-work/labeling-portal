import { beforeEach, describe, expect, it } from 'vitest';

import { loader as batchLoader } from '~/routes/batch-detail';
import { loader as reviseLoader } from '~/routes/my-work-revise';
import { loader as notFoundLoader } from '~/routes/not-found';
import { loader as overviewLoader } from '~/routes/project-overview';
import { loader as reviewLoader } from '~/routes/review';
import { loader as taskLoader } from '~/routes/task-detail';
import { loader as workLoader } from '~/routes/work';

import {
  cookieFor,
  createMember,
  createOrg,
  createTestProject,
  makeRequest,
  resetDb,
  run,
  statusOf,
} from './helpers';

describe('unknown ids', () => {
  beforeEach(resetDb);

  it('answer 404 instead of crashing', async () => {
    const org = await createOrg();
    const admin = await createMember(org.id, 'ADMIN');
    const project = await createTestProject(org.id);
    const cookie = await cookieFor(admin, org.id);
    const missing = 'does-not-exist';

    const cases: Array<[(args: never) => unknown, Record<string, string>]> = [
      [overviewLoader, { projectId: missing }],
      [batchLoader, { projectId: project.id, batchId: missing }],
      [taskLoader, { projectId: project.id, taskId: missing }],
      [workLoader, { assignmentId: missing }],
      [reviewLoader, { assignmentId: missing }],
      [reviseLoader, { assignmentId: missing }],
    ];
    for (const [loader, params] of cases) {
      const result = await run(loader, makeRequest('/x', { cookie }), params);
      expect(statusOf(result)).toBe(404);
    }
  });

  it('serves a 404 for unknown pages', async () => {
    expect(statusOf(await run(notFoundLoader, makeRequest('/nope')))).toBe(404);
  });
});
