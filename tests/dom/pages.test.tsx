import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, redirect } from 'react-router';
import { describe, expect, it } from 'vitest';

import Work, { type loader as workLoader } from '~/routes/work';

import { expectAccessible } from './axe';
import { KIND_NAMES, KINDS, type Kind } from './fixtures';
import { renderPage } from './render';

function workData(kind: Kind, id = 'a1'): Awaited<ReturnType<typeof workLoader>> {
  const { schema, data } = KINDS[kind];
  return {
    userTag: 'tag-u1',
    instructionsChanged: false,
    assignment: {
      id,
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      extensionsLeft: 3,
      draft: null,
      draftNote: null,
      draftSeconds: 0,
    },
    project: { id: 'p1', name: 'Reviews' },
    instructionsHtml: '<p>Read the task and label it.</p>',
    schema,
    task: { ref: `ref-${id}`, batch: 'Batch 1', data },
    doneToday: id === 'a1' ? 3 : 4,
  };
}

describe('work page', () => {
  for (const kind of KIND_NAMES) {
    it(`for ${kind} has no axe violations`, async () => {
      renderPage({
        path: '/work/:assignmentId',
        url: '/work/a1',
        Component: Work,
        loaderData: workData(kind),
      });
      await screen.findByText('Submit and next');
      await expectAccessible();
    });
  }

  it('says that the next task is there and puts focus on it', async () => {
    const user = userEvent.setup();
    renderPage({
      path: '/work/:assignmentId',
      url: '/work/a1',
      Component: Work,
      loaderData: (params: { assignmentId?: string }) => workData('ner', params.assignmentId),
      action: () => redirect('/work/a2'),
    });
    await user.click(await screen.findByRole('button', { name: 'Submit and next' }));
    await screen.findByText('ref ref-a2');
    expect((await screen.findByText(/^Next task loaded/)).textContent).toBe(
      'Next task loaded, reference ref-a2. 4 done today.',
    );
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Task' }));
  });

  it('opens the skip form and gives focus back when it closes', async () => {
    const user = userEvent.setup();
    renderPage({
      path: '/work/:assignmentId',
      url: '/work/a1',
      Component: Work,
      loaderData: workData('text_classification'),
    });
    const skip = await screen.findByRole('button', { name: 'Skip…' });
    await user.click(skip);
    expect(document.activeElement).toBe(screen.getAllByRole('radio', { name: /Instructions/ })[0]);
    await expectAccessible();
    await user.keyboard('{Escape}');
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(skip);
  });
});

describe('the app layout', () => {
  it('puts focus at the start of the content after a navigation', async () => {
    const user = userEvent.setup();
    renderPage({
      path: '/one',
      url: '/one',
      Component: () => <Link to="/two">To page two</Link>,
      loaderData: null,
      more: [{ path: '/two', Component: () => <h1>Page two</h1> }],
    });
    await user.click(await screen.findByRole('link', { name: 'To page two' }));
    await screen.findByText('Page two');
    expect(document.activeElement).toBe(screen.getByRole('main'));
    await expectAccessible();
  });
});
