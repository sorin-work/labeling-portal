import { describe, expect, it } from 'vitest';

import { validateAnswer } from '~/domain/answers';
import {
  DRAFT_MAX_BYTES,
  DRAFT_RETRY_AFTER_MS,
  DRAFT_SAVE_AFTER_MS,
  DRAFT_SAVE_AT_LATEST_MS,
  DRAFT_SAVE_SECONDS,
  droppedNote,
  fitDraft,
  packUnsaved,
  parseDraft,
  readUnsaved,
  restoreTestAnswers,
  saveDelay,
} from '~/domain/drafts';
import { SCHEMA_TEMPLATES, type TextClassificationSchema } from '~/domain/task-schema';

const single = SCHEMA_TEMPLATES.text_classification;
const multi: TextClassificationSchema = { ...single, multiple: true };
const ner = SCHEMA_TEMPLATES.ner;
const pairwise = SCHEMA_TEMPLATES.pairwise;
const bbox = SCHEMA_TEMPLATES.bbox;

describe('parseDraft', () => {
  it('reads a JSON object', () => {
    expect(parseDraft('{"labels":["positive"]}')).toEqual({
      ok: true,
      draft: { labels: ['positive'] },
    });
  });

  it('treats a missing or empty field as no change to the draft', () => {
    expect(parseDraft(null)).toEqual({ ok: true, draft: null });
    expect(parseDraft('')).toEqual({ ok: true, draft: null });
  });

  it('refuses anything that is not a JSON object', () => {
    for (const raw of ['{"labels":', '[1,2]', '"text"', '42', 'null']) {
      expect(parseDraft(raw)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses drafts over the size limit, counted in bytes', () => {
    const fits = JSON.stringify({ rationale: 'a'.repeat(DRAFT_MAX_BYTES - 16) });
    expect(parseDraft(fits).ok).toBe(true);
    expect(parseDraft(JSON.stringify({ rationale: 'a'.repeat(DRAFT_MAX_BYTES) }))).toEqual({
      ok: false,
      reason: 'too_large',
    });
    // two bytes per character in UTF-8
    expect(parseDraft(JSON.stringify({ rationale: 'é'.repeat(DRAFT_MAX_BYTES / 2) }))).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });
});

describe('fitDraft', () => {
  it('keeps a pairwise draft that is not a valid answer yet', () => {
    const [first] = pairwise.dimensions;
    const stored = { preference: null, scores: { a: { [first.key]: 4 }, b: {} }, rationale: 'B ' };
    expect(validateAnswer(pairwise, {}, stored).ok).toBe(false);
    expect(fitDraft(pairwise, {}, stored)).toEqual({ answer: stored, dropped: 0 });
  });

  it('drops pairwise parts the schema does not know', () => {
    const [first] = pairwise.dimensions;
    const fitted = fitDraft(
      { ...pairwise, allowTie: false },
      {},
      { preference: 'tie', scores: { a: { [first.key]: 9, gone: 3 }, b: 'x' }, rationale: 7 },
    );
    expect(fitted).toEqual({
      answer: { preference: null, scores: { a: {}, b: {} }, rationale: '' },
      dropped: 3,
    });
  });

  it('keeps known labels in the order they were picked', () => {
    expect(fitDraft(multi, {}, { labels: ['negative', 'gone', 'positive', 'negative'] })).toEqual({
      answer: { labels: ['negative', 'positive'] },
      dropped: 2,
    });
    expect(fitDraft(single, {}, { labels: ['negative', 'positive'] })).toEqual({
      answer: { labels: ['negative'] },
      dropped: 1,
    });
    expect(fitDraft(single, {}, { labels: [] })).toEqual({ answer: { labels: [] }, dropped: 0 });
  });

  it('keeps spans that still fit the text and the entity types', () => {
    const data = { text: 'Ada Lovelace met Babbage.' };
    const fitted = fitDraft(ner, data, {
      spans: [
        { start: 17, end: 24, label: 'PERSON' },
        { start: 0, end: 12, label: 'PERSON' },
        { start: 0, end: 3, label: 'PERSON' },
        { start: 13, end: 16, label: 'VERB' },
        { start: 20, end: 99, label: 'PERSON' },
        { start: 'x', end: 2, label: 'PERSON' },
      ],
    });
    // overlapping spans replace each other, as they do while labeling
    expect(fitted).toEqual({
      answer: {
        spans: [
          { start: 0, end: 3, label: 'PERSON' },
          { start: 17, end: 24, label: 'PERSON' },
        ],
      },
      dropped: 4,
    });
  });

  it('keeps boxes with a known label and the image size', () => {
    const [label] = bbox.labels;
    const stored = {
      imageWidth: 640,
      imageHeight: 480,
      boxes: [
        { x: 10, y: 20, w: 100, h: 50, label },
        { x: 10, y: 20, w: 100, h: 50, label: 'gone' },
        { x: 10, y: 20, w: 0, h: 50, label },
        { x: 10, label },
      ],
    };
    expect(fitDraft(bbox, {}, stored)).toEqual({
      answer: {
        imageWidth: 640,
        imageHeight: 480,
        boxes: [{ x: 10, y: 20, w: 100, h: 50, label }],
      },
      dropped: 3,
    });
    expect(fitDraft(bbox, {}, { boxes: [] })).toEqual({ answer: null, dropped: 0 });
  });

  it('cuts boxes to the image and drops the ones the schema now refuses', () => {
    const [label] = bbox.labels;
    const strict = { ...bbox, minBoxSize: 20 };
    const stored = {
      imageWidth: 200,
      imageHeight: 100,
      boxes: [
        { x: 10, y: 10, w: 15, h: 40, label }, // narrower than the new minimum
        { x: -5, y: 50, w: 60, h: 80, label }, // hangs over two edges
        { x: 190, y: 10, w: 40, h: 40, label }, // only 10 wide inside the image
        { x: 300, y: 10, w: 40, h: 40, label }, // outside altogether
        { x: 50, y: 20, w: 30, h: 30, label },
      ],
    };
    const fitted = fitDraft(strict, {}, stored);
    expect(fitted).toEqual({
      answer: {
        imageWidth: 200,
        imageHeight: 100,
        boxes: [
          { x: 0, y: 50, w: 60, h: 50, label },
          { x: 50, y: 20, w: 30, h: 30, label },
        ],
      },
      dropped: 3,
    });
    // what is left can be handed in as it is
    expect(validateAnswer(strict, {}, fitted.answer).ok).toBe(true);
    expect(validateAnswer(strict, {}, stored).ok).toBe(false);
  });

  it('has no answer for a draft of another kind or no draft at all', () => {
    const nothing = { answer: null, dropped: 0 };
    expect(fitDraft(single, {}, null)).toEqual(nothing);
    expect(fitDraft(single, {}, 'labels')).toEqual(nothing);
    expect(fitDraft(single, {}, { spans: [] })).toEqual(nothing);
    expect(fitDraft(ner, { text: 'x' }, { labels: ['positive'] })).toEqual(nothing);
  });

  it('says what was left out, in the words of the kind', () => {
    expect(droppedNote(bbox, 0)).toBeNull();
    expect(droppedNote(bbox, 1)).toMatch(/^One box from your draft no longer fits .* was left out/);
    expect(droppedNote(bbox, 3)).toMatch(/^3 boxes from your draft no longer fit .* were left out/);
    expect(droppedNote(ner, 2)).toMatch(/^2 spans /);
    expect(droppedNote(single, 1)).toMatch(/^One label /);
  });
});

describe('restoreTestAnswers', () => {
  const tasks = [
    { id: 'q1', data: { text: 'one' } },
    { id: 'q2', data: { text: 'two' } },
  ];
  const stored = JSON.stringify({
    attempt: 1,
    answers: { q1: { labels: ['positive'] }, q2: { spans: [] }, old: { labels: ['negative'] } },
  });

  it('brings back the answers of the same attempt for questions still in the test', () => {
    expect(restoreTestAnswers(single, tasks, 1, stored)).toEqual({ q1: { labels: ['positive'] } });
  });

  it('ignores answers from an attempt that was already handed in', () => {
    expect(restoreTestAnswers(single, tasks, 2, stored)).toEqual({});
  });

  it('ignores a missing or broken value', () => {
    expect(restoreTestAnswers(single, tasks, 0, null)).toEqual({});
    expect(restoreTestAnswers(single, tasks, 0, '{"attempt":0,')).toEqual({});
    expect(restoreTestAnswers(single, tasks, 0, '{"attempt":0,"answers":[]}')).toEqual({});
  });
});

describe('unsaved work of a closing page', () => {
  const server = { json: '{"labels":["positive"]}', seconds: 40 };

  it('is nothing when the server has it all', () => {
    expect(packUnsaved(server, server)).toBeNull();
    expect(packUnsaved({ json: '', seconds: 0 }, { json: '', seconds: 0 })).toBeNull();
    expect(readUnsaved(null)).toBeNull();
  });

  it('carries a changed answer and the working time to the next page', () => {
    const packed = packUnsaved({ json: '{"labels":["negative"]}', seconds: 47 }, server);
    expect(readUnsaved(packed)).toEqual({ draft: { labels: ['negative'] }, seconds: 47 });
  });

  it('carries the time alone when the answer did not change', () => {
    const packed = packUnsaved({ ...server, seconds: 55 }, server);
    expect(readUnsaved(packed)).toEqual({ draft: null, seconds: 55 });
  });

  it('reads nothing from a broken value', () => {
    expect(readUnsaved('{"draft":')).toBeNull();
    expect(readUnsaved('[]')).toBeNull();
    expect(readUnsaved('{"draft":"[1]","seconds":"x"}')).toEqual({ draft: null, seconds: 0 });
  });
});

describe('saveDelay', () => {
  const now = 1_000_000;
  const clean = { changedAt: null, dirtySince: null, unsavedSeconds: 0, failedAt: null };

  it('has nothing to do while nothing changed', () => {
    expect(saveDelay(clean, now)).toBeNull();
    expect(saveDelay({ ...clean, unsavedSeconds: DRAFT_SAVE_SECONDS - 1 }, now)).toBeNull();
  });

  it('waits for a pause after the last change', () => {
    const work = { ...clean, changedAt: now - 500, dirtySince: now - 500 };
    expect(saveDelay(work, now)).toBe(DRAFT_SAVE_AFTER_MS - 500);
    expect(saveDelay(work, now + DRAFT_SAVE_AFTER_MS)).toBe(0);
  });

  it('does not wait for a pause forever while changes keep coming', () => {
    const work = {
      ...clean,
      changedAt: now - 100,
      dirtySince: now - DRAFT_SAVE_AT_LATEST_MS + 300,
    };
    expect(saveDelay(work, now)).toBe(300);
  });

  it('saves working time alone once enough of it is unsaved', () => {
    expect(saveDelay({ ...clean, unsavedSeconds: DRAFT_SAVE_SECONDS }, now)).toBe(0);
  });

  it('holds back after a failed save', () => {
    const work = {
      ...clean,
      changedAt: now - 5_000,
      dirtySince: now - 5_000,
      failedAt: now - 1_000,
    };
    expect(saveDelay(work, now)).toBe(DRAFT_RETRY_AFTER_MS - 1_000);
    expect(saveDelay({ ...clean, failedAt: now - 1_000 }, now)).toBeNull();
  });
});
