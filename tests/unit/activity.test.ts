import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_ACTIONS,
  describeActivity,
  describeSettingsChanges,
  isActivityAction,
  settingsChanges,
  type ProjectSettings,
} from '~/domain/activity';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';

const settings: ProjectSettings = {
  name: 'Sentiment',
  description: '',
  instructions: 'Read the text.',
  overlap: 1,
  timeLimitMinutes: 30,
  reviewRequired: true,
  reviewSamplePercent: 100,
  disputeWindowDays: 14,
  goldFeedback: true,
  queueOrder: 'IN_ORDER',
  goldEvery: null,
  agreementThreshold: null,
  maxExtraAnnotators: 1,
  dailyTaskLimit: null,
  qualificationRequired: false,
  qualificationPassPercent: 80,
  payMode: 'PER_TASK',
  rateCents: 8,
};

describe('settingsChanges', () => {
  it('maps each changed field to before and after, and leaves the rest out', () => {
    expect(settingsChanges(settings, { ...settings })).toEqual({});
    expect(settingsChanges(settings, { ...settings, rateCents: 10, goldEvery: 20 })).toEqual({
      goldEvery: [null, 20],
      rateCents: [8, 10],
    });
  });

  it('keeps the instructions as two lengths, never the text', () => {
    const changes = settingsChanges(settings, { ...settings, instructions: 'A secret plan.' });
    expect(changes).toEqual({ instructions: [14, 14] });
    expect(JSON.stringify(changes)).not.toContain('secret');
    // only whitespace around it is no change
    expect(settingsChanges(settings, { ...settings, instructions: ' Read the text.\n' })).toEqual(
      {},
    );
  });
});

describe('describeSettingsChanges', () => {
  it('words every kind of field', () => {
    expect(
      describeSettingsChanges({
        rateCents: [8, 10],
        payMode: ['PER_TASK', 'HOURLY'],
        reviewRequired: [true, false],
        timeLimitMinutes: [30, 45],
        goldEvery: [null, 20],
        name: ['A', 'B'],
        instructions: [10, 25],
      }),
    ).toEqual([
      'the rate from $0.08 to $0.10',
      'the pay mode from per task to hourly',
      'review from on to off',
      'the time limit from 30 minutes to 45 minutes',
      'gold spacing from none to one in 20',
      'the name from “A” to “B”',
      'the instructions (10 to 25 characters)',
    ]);
  });

  it('diffs a schema pair again', () => {
    const before = SCHEMA_TEMPLATES.text_classification;
    const after = { ...before, labels: [...before.labels, 'spam'] };
    expect(describeSettingsChanges({ schema: [before, after] })).toEqual([
      'the task schema (added the label “spam”)',
    ]);
  });

  it('skips what is not a pair', () => {
    expect(describeSettingsChanges(null)).toEqual([]);
    expect(describeSettingsChanges({ rateCents: 5, name: ['only one'] })).toEqual([]);
  });
});

describe('describeActivity', () => {
  it('has a sentence for every action it records', () => {
    for (const action of Object.keys(ACTIVITY_ACTIONS)) {
      const text = describeActivity(action, {});
      expect(text, action).not.toBe(action);
      expect(text.length, action).toBeGreaterThan(5);
    }
  });

  it('tells signing out everywhere apart from an admin ending the sessions', () => {
    expect(describeActivity('person.sessions_ended', { userName: 'Dana', own: true })).toBe(
      'signed out everywhere',
    );
    expect(describeActivity('person.sessions_ended', { userName: 'Dana', own: false })).toBe(
      'ended every session of Dana',
    );
    expect(
      describeActivity('token.revoked', { name: 'Nightly', prefix: 'lp_ab', userName: 'Dana' }),
    ).toBe('revoked the API token “Nightly” (lp_ab…) of Dana');
  });

  it('names the person from the entry, so it reads the same once they are gone', () => {
    expect(describeActivity('person.password', { userId: 'u1', userName: 'Dana' })).toBe(
      'set a new password for Dana',
    );
    expect(
      describeActivity('person.role', {
        userName: 'Dana',
        from: 'ANNOTATOR',
        to: 'PROJECT_MANAGER',
      }),
    ).toBe('changed the role of Dana from annotator to project manager');
    expect(
      describeActivity('review.decided', {
        userName: 'Ann',
        decision: 'SEND_BACK',
        position: 4,
        qaScore: 2,
      }),
    ).toBe('sent back the work of Ann on task #4 (QA 2)');
    expect(describeActivity('project.settings', { changes: { rateCents: [8, 10] } })).toBe(
      'changed the rate from $0.08 to $0.10',
    );
  });

  it('falls back to the action name for an action it does not know', () => {
    expect(describeActivity('something.new', null)).toBe('something.new');
    expect(isActivityAction('something.new')).toBe(false);
    expect(isActivityAction('toString')).toBe(false);
    expect(isActivityAction('auth.locked')).toBe(true);
  });
});

describe('the daily limit and released claims in the trail', () => {
  it('reads as sentences', () => {
    expect(settingsChanges(settings, { ...settings, dailyTaskLimit: 40 })).toEqual({
      dailyTaskLimit: [null, 40],
    });
    expect(describeSettingsChanges({ dailyTaskLimit: [null, 40] })).toEqual([
      'the daily limit from none to 40 tasks a day',
    ]);
    expect(
      describeActivity('assignment.released', { userName: 'Ann', position: 7, seconds: 720 }),
    ).toBe('released the claim of Ann on task #7, crediting 12 minutes of their time');
    expect(
      describeActivity('assignment.released', { userName: 'Ann', position: 7, seconds: 0 }),
    ).toBe('released the claim of Ann on task #7');
  });
});
