import { describe, expect, it } from 'vitest';

import { parseImport } from '~/domain/import';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';
import { sampleFile } from '~/domain/template';

describe('sampleFile', () => {
  for (const schema of Object.values(SCHEMA_TEMPLATES)) {
    it(`produces importable csv and jsonl for ${schema.kind}`, () => {
      for (const format of ['csv', 'jsonl'] as const) {
        const result = parseImport(
          sampleFile(schema, format),
          format === 'csv' ? 'CSV' : 'JSONL',
          schema,
        );
        expect(result.errors).toEqual([]);
        expect(result.rows).toHaveLength(2);
        expect(result.rows[1].gold).toBeDefined();
      }
    });
  }
});
