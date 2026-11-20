import { describe, expect, it } from 'vitest';

import { parseProjectForm } from '~/domain/project-form';
import { parseReviewForm } from '~/domain/review-form';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

describe('parseReviewForm', () => {
  it('maps the button to a decision', () => {
    expect(parseReviewForm(form({ intent: 'approve', qaScore: '4' }))).toEqual({
      ok: true,
      value: { decision: 'APPROVE', qaScore: 4, feedback: '' },
    });
    expect(parseReviewForm(form({ intent: 'fix', qaScore: '' }))).toMatchObject({
      ok: true,
      value: { decision: 'FIX', qaScore: null },
    });
  });

  it('rejects unknown decisions and bad scores', () => {
    expect(parseReviewForm(form({ intent: 'delete' })).ok).toBe(false);
    expect(parseReviewForm(form({ intent: 'constructor' })).ok).toBe(false);
    expect(parseReviewForm(form({ intent: 'approve', qaScore: '6' })).ok).toBe(false);
    expect(parseReviewForm(form({ intent: 'approve', qaScore: '2.5' })).ok).toBe(false);
  });

  it('needs feedback to send work back', () => {
    expect(parseReviewForm(form({ intent: 'send_back', feedback: '   ' })).ok).toBe(false);
    expect(parseReviewForm(form({ intent: 'send_back', feedback: 'Label the sarcasm' })).ok).toBe(
      true,
    );
  });
});

describe('parseProjectForm', () => {
  const valid = {
    name: 'Toxicity',
    description: '',
    instructions: '',
    schema: JSON.stringify(SCHEMA_TEMPLATES.text_classification),
    overlap: '3',
    timeLimitMinutes: '15',
    reviewRequired: 'on',
    qualificationPassPercent: '75',
    payMode: 'HOURLY',
    rate: '18.50',
  };

  it('reads every field', () => {
    const result = parseProjectForm(form(valid));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        name: 'Toxicity',
        overlap: 3,
        timeLimitMinutes: 15,
        reviewRequired: true,
        reviewSamplePercent: 100,
        disputeWindowDays: 14,
        qualificationRequired: false,
        qualificationPassPercent: 75,
        payMode: 'HOURLY',
        rateCents: 1850,
      });
    }
  });

  it('reads the share of submissions to review', () => {
    const sampled = parseProjectForm(form({ ...valid, reviewSamplePercent: '20' }));
    expect(sampled.ok && sampled.value.reviewSamplePercent).toBe(20);
    const none = parseProjectForm(form({ ...valid, reviewSamplePercent: '0' }));
    expect(none.ok && none.value.reviewSamplePercent).toBe(0);

    for (const bad of ['', '101', '-1', '12.5', 'half']) {
      const result = parseProjectForm(form({ ...valid, reviewSamplePercent: bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(Object.keys(result.errors)).toEqual(['reviewSamplePercent']);
    }
  });

  it('reads the dispute window, which a blank does not switch off', () => {
    const week = parseProjectForm(form({ ...valid, disputeWindowDays: '7' }));
    expect(week.ok && week.value.disputeWindowDays).toBe(7);
    const off = parseProjectForm(form({ ...valid, disputeWindowDays: '0' }));
    expect(off.ok && off.value.disputeWindowDays).toBe(0);

    for (const bad of ['', '91', '-1', '1.5']) {
      const result = parseProjectForm(form({ ...valid, disputeWindowDays: bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(Object.keys(result.errors)).toEqual(['disputeWindowDays']);
    }
  });

  it('reports each bad field', () => {
    const result = parseProjectForm(
      form({ ...valid, name: 'x', overlap: '0', rate: 'free', schema: '{' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(Object.keys(result.errors).sort()).toEqual(['name', 'overlap', 'rate', 'schema']);
  });
});
