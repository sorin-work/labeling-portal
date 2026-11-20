import { screen } from '@testing-library/react';
import { describe, it } from 'vitest';

import Work from '~/routes/work';

import { expectAccessible } from './axe';
import { KINDS } from './fixtures';
import { renderPage } from './render';

describe('pages', () => {
  it('work page', async () => {
    const { schema, data } = KINDS.ner;
    renderPage({
      path: '/work/:assignmentId',
      url: '/work/a1',
      Component: Work,
      loaderData: {
        userId: 'u1',
        instructionsChanged: false,
        assignment: {
          id: 'a1',
          claimedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          canExtend: true,
          draft: null,
          draftNote: null,
          draftSeconds: 0,
        },
        project: { id: 'p1', name: 'Reviews' },
        instructionsHtml: '<p>Mark people and places.</p>',
        schema,
        task: { ref: 'abc123', batch: 'Batch 1', data },
        doneToday: 3,
      },
    });
    await screen.findByText('Submit and next');
    await expectAccessible();
  });
});
