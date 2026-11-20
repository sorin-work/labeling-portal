import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import MyWorkRevise, { type loader as reviseLoader } from '~/routes/my-work-revise';
import Earnings, { type loader as earningsLoader } from '~/routes/earnings';
import Payouts, { type loader as payoutsLoader } from '~/routes/payouts';
import ProjectQualification, {
  type loader as qualificationLoader,
} from '~/routes/project-qualification';
import ProjectQuality, { type loader as qualityLoader } from '~/routes/project-quality';
import ProjectSettings, { type loader as settingsLoader } from '~/routes/project-settings';
import Review, { type loader as reviewLoader } from '~/routes/review';
import TaskDetail, { type loader as taskLoader } from '~/routes/task-detail';

import { expectAccessible } from './axe';
import { KIND_NAMES, KINDS, type Kind } from './fixtures';
import { renderPage } from './render';

type Data<L extends (...args: never[]) => unknown> = Awaited<ReturnType<L>>;

const answers = {
  text_classification: { labels: ['positive'] },
  image_classification: { labels: ['person', 'car'] },
  ner: { spans: [{ start: 0, end: 12, label: 'PERSON' }] },
  pairwise: {
    preference: 'A',
    scores: { a: { helpful: 4, correct: 5 }, b: { helpful: 2, correct: 1 } },
    rationale: 'A names a prime, B does not.',
  },
  bbox: {
    boxes: [{ x: 10, y: 20, w: 30, h: 40, label: 'car' }],
    imageWidth: 640,
    imageHeight: 480,
  },
} as const;

const at = new Date('2026-11-20T10:00:00Z');

function review(kind: Kind): Data<typeof reviewLoader> {
  return {
    project: { id: 'p1', name: 'Reviews' },
    schema: KINDS[kind].schema,
    ownWork: false,
    hold: { reviewer: 'Rita Reviewer', mine: true, until: new Date(at.getTime() + 15 * 60_000) },
    sampleNote: null,
    assignment: {
      id: 'a1',
      annotator: 'Ann Annotator',
      submittedAt: at,
      activeSeconds: 95,
      reviewStatus: 'PENDING',
      answer: answers[kind] as never,
      suggestionUse: 'unchanged',
    },
    task: { id: 't1', externalId: 'row-7', data: KINDS[kind].data },
    history: [
      {
        id: 'r1',
        reviewer: 'Rita Reviewer',
        decision: 'SEND_BACK',
        qaScore: 2,
        feedback: 'Missed one.',
        createdAt: at,
        overturned: false,
      },
    ],
  };
}

describe('pages have no axe violations', () => {
  for (const kind of KIND_NAMES) {
    it(`review, ${kind}`, async () => {
      renderPage({
        path: '/review/:assignmentId',
        url: '/review/a1',
        Component: Review,
        loaderData: review(kind),
      });
      await screen.findByText('Approve');
      await expectAccessible();
    });
  }
});

function revise(kind: Kind, mode: 'revise' | 'compare'): Data<typeof reviseLoader> {
  return {
    userTag: 'tag-u1',
    mode,
    corrected: mode === 'compare' ? (answers[kind] as never) : null,
    goldCheck: null,
    id: 'a1',
    projectName: 'Reviews',
    schema: KINDS[kind].schema,
    data: KINDS[kind].data,
    answer: answers[kind] as never,
    draft: null,
    draftNote: null,
    draftSeconds: 0,
    feedback: 'Please look again at the second half.',
    editable: mode === 'revise',
    dispute: null,
    disputeUntil: new Date(at.getTime() + 14 * 86_400_000),
    disputeClosed: null,
  };
}

function qualification(kind: Kind): Data<typeof qualificationLoader> {
  return {
    userId: 'u1',
    project: { id: 'p1', name: 'Reviews' },
    schema: KINDS[kind].schema,
    status: {
      qualified: false,
      required: true,
      attempts: 1,
      attemptsLeft: 2,
      lastScore: 50,
      passPercent: 80,
      taskCount: 2,
    },
    justFailed: false,
    instructionsHtml: '<p>Label each example.</p>',
    tasks: [
      { id: 'q1', data: KINDS[kind].data },
      { id: 'q2', data: KINDS[kind].data },
    ],
  };
}

function task(kind: Kind): Data<typeof taskLoader> {
  const submission = (id: string, annotator: string) => ({
    id,
    annotator,
    status: 'SUBMITTED' as const,
    reviewStatus: 'APPROVED' as const,
    ref: id.toUpperCase(),
    sampleNote: null,
    heldBy: null,
    claimedAt: at,
    submittedAt: at,
    activeSeconds: 80,
    goldScore: null,
    skipReason: null,
    answer: answers[kind] as never,
    corrected: false,
    reviews: [],
  });
  return {
    projectId: 'p1',
    schema: KINDS[kind].schema,
    gold: null,
    openBatches: [],
    canUseAsGold: false,
    adjudication: null,
    canEscalate: false,
    task: {
      id: 't1',
      externalId: 'row-7',
      position: 7,
      status: 'COMPLETE',
      isGold: false,
      goldRetired: false,
      data: KINDS[kind].data,
      consensus: answers[kind] as never,
      majority: null,
      agreement: 1,
      extraSlots: 0,
      source: 'majority',
      adjudicated: null,
      batch: { id: 'b1', name: 'Batch 1' },
    },
    assignments: [submission('a1', 'Ann'), submission('a2', 'Bob')],
  };
}

describe('more pages have no axe violations', () => {
  for (const kind of KIND_NAMES) {
    for (const mode of ['revise', 'compare'] as const) {
      it(`revise (${mode}), ${kind}`, async () => {
        renderPage({
          path: '/my-work/:assignmentId',
          url: '/my-work/a1',
          Component: MyWorkRevise,
          loaderData: revise(kind, mode),
        });
        await screen.findAllByText(/Reviews/);
        await expectAccessible();
      });
    }
    it(`qualification test, ${kind}`, async () => {
      renderPage({
        path: '/projects/:projectId/qualification',
        url: '/projects/p1/qualification',
        Component: ProjectQualification,
        loaderData: qualification(kind),
        inProject: true,
      });
      await screen.findAllByRole('button', { name: /Submit/ });
      await expectAccessible();
    });
    it(`task detail, ${kind}`, async () => {
      renderPage({
        path: '/projects/:projectId/tasks/:taskId',
        url: '/projects/p1/tasks/t1',
        Component: TaskDetail,
        loaderData: task(kind),
        inProject: true,
      });
      await screen.findByText(/Ann/);
      await expectAccessible();
    });
  }
});

const settings: Data<typeof settingsLoader> = {
  project: {
    id: 'p1',
    status: 'ACTIVE',
    name: 'Reviews',
    description: 'Product reviews',
    instructions: 'Mark people and places.',
    schema: JSON.stringify(KINDS.ner.schema, null, 2),
    overlap: 2,
    timeLimitMinutes: 30,
    reviewRequired: true,
    reviewSamplePercent: 100,
    disputeWindowDays: 14,
    goldFeedback: true,
    qualificationRequired: false,
    qualificationPassPercent: 80,
    payMode: 'PER_TASK',
    rate: '0.25',
    queueOrder: 'IMPORT',
    goldEvery: null,
    agreementThreshold: null,
    maxExtraAnnotators: 0,
  },
  usage: {
    tasks: 10,
    answers: { submission: 4 },
    names: new Map([['PERSON', { submission: 3 }]]),
    multiLabel: {},
    ties: {},
    scored: {},
    dimensions: new Map(),
  },
  prelabel: {
    text: '{"rule":"phrases","entities":{"PERSON":["Ada"]}}',
    rules: [
      {
        name: 'phrases',
        title: 'Phrases per entity type',
        example: '{"rule":"phrases","entities":{"PERSON":["Ada Lovelace"]}}',
      },
    ],
  },
};

const annotator = (userId: string, name: string, flagged: boolean) => ({
  userId,
  name,
  submitted: 12,
  reviewed: 10,
  reviewable: 11,
  reviewedSubmissions: 10,
  reviewedShare: 0.91,
  approved: 9,
  sentBack: 1,
  skipped: 1,
  approvalRate: 0.9,
  avgQaScore: 4.2,
  avgSeconds: 70,
  tasksPerHour: 40,
  goldAttempts: 6,
  goldAccuracy: flagged ? 0.5 : 0.95,
  flagged,
});

const quality: Data<typeof qualityLoader> = {
  projectId: 'p1',
  annotators: [annotator('u1', 'Ann', false), annotator('u2', 'Bob', true)],
  skipReasons: [{ reason: 'Content is broken or unreadable', count: 2 }],
  agreement: {
    categorical: true,
    fleiss: 0.61,
    pairs: [{ a: 'Ann', b: 'Bob', kappa: 0.6, shared: 8 }],
    meanTaskAgreement: 0.8,
    completedTasks: 8,
    adjudicatedTasks: 1,
    majorityTasks: 7,
    waitingAdjudication: 0,
  },
  daily: [
    { day: '2026-11-18', submitted: 5, accepted: 4 },
    { day: '2026-11-19', submitted: 7, accepted: 6 },
  ],
  suggestions: {
    tasks: 4,
    annotators: [{ userId: 'u1', name: 'Ann', withSuggestion: 4, unchanged: 3, avgSeconds: 40 }],
    againstGold: [{ source: 'keywords', tasks: 2, score: 0.5 }],
  },
  lowestGold: [
    {
      taskId: 't1',
      position: 3,
      externalId: 'row-3',
      preview: 'Ada Lovelace was…',
      answers: 4,
      average: 0.5,
    },
  ],
};

const payouts: Data<typeof payoutsLoader> = {
  range: { from: '2026-11-01', to: '2026-11-20' },
  projectId: null,
  projects: [{ id: 'p1', name: 'Reviews' }],
  lines: [
    {
      userId: 'u1',
      name: 'Ann',
      email: 'ann@example.test',
      tasks: 12,
      seconds: 840,
      amountCents: 300,
      projects: [
        {
          projectId: 'p1',
          projectName: 'Reviews',
          payMode: 'PER_TASK',
          rateCents: 25,
          tasks: 12,
          seconds: 840,
          amountCents: 300,
        },
      ],
    },
  ],
  totalCents: 300,
  pending: 2,
};

describe('manager pages have no axe violations', () => {
  it('project settings', async () => {
    renderPage({
      path: '/projects/:projectId/settings',
      url: '/projects/p1/settings',
      Component: ProjectSettings,
      loaderData: settings,
      inProject: true,
    });
    await screen.findAllByRole('button', { name: /Save/ });
    await expectAccessible();
  });

  it('quality', async () => {
    renderPage({
      path: '/projects/:projectId/quality',
      url: '/projects/p1/quality',
      Component: ProjectQuality,
      loaderData: quality,
      inProject: true,
    });
    await screen.findAllByText('Bob');
    await expectAccessible();
  });

  it('earnings', async () => {
    const block = {
      projectId: 'p1',
      projectName: 'Reviews',
      payMode: 'PER_TASK' as const,
      rateCents: 25,
      tasks: 12,
      seconds: 840,
      amountCents: 300,
    };
    const earnings: Data<typeof earningsLoader> = {
      range: { from: '2026-11-01', to: '2026-11-20' },
      payable: { blocks: [block], tasks: 12, seconds: 840, totalCents: 300 },
      waiting: {
        blocks: [{ ...block, tasks: 2, amountCents: 50 }],
        tasks: 2,
        seconds: 100,
        totalCents: 50,
      },
      sentBack: { blocks: [], tasks: 0, seconds: 0, totalCents: 0 },
    };
    renderPage({ path: '/earnings', url: '/earnings', Component: Earnings, loaderData: earnings });
    await screen.findAllByText('Reviews');
    await expectAccessible();
  });

  it('payouts', async () => {
    renderPage({ path: '/payouts', url: '/payouts', Component: Payouts, loaderData: payouts });
    await screen.findAllByText('Ann');
    await expectAccessible();
  });
});

describe('a review of an image that did not load', () => {
  it('can be sent back, not approved or fixed', async () => {
    renderPage({
      path: '/review/:assignmentId',
      url: '/review/a1',
      Component: Review,
      loaderData: review('image_classification'),
    });
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toHaveProperty('disabled', false);
    act(() => {
      screen.getByRole('img', { name: 'The image to classify' }).dispatchEvent(new Event('error'));
    });
    expect(approve).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Fix it myself' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Send back' })).toHaveProperty('disabled', false);
  });
});
