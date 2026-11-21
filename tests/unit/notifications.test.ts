import { describe, expect, it } from 'vitest';

import { describeNotification, NOTIFICATION_KINDS } from '~/domain/notifications';

describe('describeNotification', () => {
  it('says what happened without any answer or reason', () => {
    const base = { projectName: 'Sentiment', position: 7, actorName: 'Rafael' };
    expect(describeNotification('review.sent_back', base)).toBe(
      'Rafael sent back your work on task #7 in “Sentiment”. It needs changes.',
    );
    expect(describeNotification('review.fixed', base)).toBe(
      'Rafael corrected your work on task #7 in “Sentiment”.',
    );
    expect(describeNotification('dispute.resolved', { ...base, outcome: 'OVERTURNED' })).toBe(
      'Rafael overturned the decision you disputed on task #7 in “Sentiment”.',
    );
    expect(
      describeNotification('dispute.resolved', { ...base, outcome: 'UPHELD', role: 'reviewer' }),
    ).toBe('Rafael upheld your decision on task #7 in “Sentiment” after a dispute.');
    expect(
      describeNotification('gold.rescored', { projectName: 'Sentiment', from: 0, to: 1 }),
    ).toBe(
      'Your score on a gold task in “Sentiment” changed from 0% to 100% after its expected answer was corrected.',
    );
  });

  it('reads an unknown kind as its name, and has a sentence for every kind', () => {
    expect(describeNotification('something.new', {})).toBe('something.new');
    for (const kind of Object.keys(NOTIFICATION_KINDS)) {
      expect(describeNotification(kind, {})).not.toBe(kind);
    }
  });
});
