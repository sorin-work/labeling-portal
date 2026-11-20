import { describe, expect, it } from 'vitest';

import { withoutImportId } from '~/domain/import';
import { assignmentRef, refSuffix } from '~/domain/reference';

describe('assignmentRef', () => {
  it('is the end of the assignment id, the same form for every task', () => {
    expect(assignmentRef('cmwpejj9o002tj76wzy4uspva')).toBe('USPVA'.padStart(6, '4'));
    expect(assignmentRef('cmwpejj9o002tj76wzy4uspva')).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('is read back however the annotator typed it', () => {
    expect(refSuffix('4USPVA')).toBe('4uspva');
    expect(refSuffix(' ref 4uspva ')).toBe('4uspva');
    expect(refSuffix('Ref: 4USPVA')).toBe('4uspva');
    expect(refSuffix('positive')).toBeNull();
    expect(refSuffix('t12')).toBeNull();
  });
});

describe('withoutImportId', () => {
  it('drops the id a row was imported with and keeps the rest', () => {
    expect(withoutImportId({ id: 't1', text: 'hello', width: 640 })).toEqual({
      text: 'hello',
      width: 640,
    });
    expect(withoutImportId({ text: 'hello' })).toEqual({ text: 'hello' });
  });
});
