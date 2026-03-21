import type { Answer } from './answers';
import { parseCsv } from './csv';
import { parseGold } from './gold';
import { requiredFields, type TaskSchema } from './task-schema';

export type ImportFormat = 'CSV' | 'JSONL';

export type ImportRow = {
  line: number;
  externalId: string | null;
  data: Record<string, unknown>;
  /** set for gold (honeypot) tasks */
  gold?: Answer;
};

export type ImportError = { line: number; message: string };

export type ImportResult = {
  format: ImportFormat;
  rows: ImportRow[];
  errors: ImportError[];
};

export const MAX_IMPORT_ROWS = 5000;

/** Columns/keys with a leading underscore are instructions to the importer, not task data. */
const ID_KEYS = ['_id', 'id'];
const GOLD_KEY = '_gold';

export function detectFormat(filename: string, text: string): ImportFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson') || lower.endsWith('.json')) {
    return 'JSONL';
  }
  if (lower.endsWith('.csv')) return 'CSV';
  return text.trimStart().startsWith('{') ? 'JSONL' : 'CSV';
}

function readRecords(text: string, format: ImportFormat, errors: ImportError[]) {
  const records: Array<{ line: number; data: Record<string, unknown> }> = [];
  if (format === 'CSV') {
    const table = parseCsv(text);
    if (table.header.length === 0) return records;
    const dupes = table.header.filter((h, i) => table.header.indexOf(h) !== i);
    if (dupes.length) {
      errors.push({ line: 1, message: `Duplicate column: ${dupes[0]}` });
      return records;
    }
    for (const row of table.rows) {
      if (row.values.length !== table.header.length) {
        errors.push({
          line: row.line,
          message: `Expected ${table.header.length} columns but found ${row.values.length}`,
        });
        continue;
      }
      const data: Record<string, unknown> = {};
      table.header.forEach((key, i) => (data[key] = row.values[i]));
      records.push({ line: row.line, data });
    }
    return records;
  }

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (!raw.trim()) return;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ line, message: 'Each line must be a JSON object' });
        return;
      }
      records.push({ line, data: value as Record<string, unknown> });
    } catch {
      errors.push({ line, message: 'Not valid JSON' });
    }
  });
  return records;
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function isImageRef(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^https?:\/\/\S+$/i.test(value) || /^\/\S+$/.test(value);
}

/** Parses an uploaded file into task rows, collecting every problem with its line number. */
export function parseImport(text: string, format: ImportFormat, schema: TaskSchema): ImportResult {
  const errors: ImportError[] = [];
  const records = readRecords(text, format, errors);
  const rows: ImportRow[] = [];
  const seenIds = new Map<string, number>();
  const required = requiredFields(schema);

  if (records.length > MAX_IMPORT_ROWS) {
    return {
      format,
      rows: [],
      errors: [{ line: 0, message: `A batch can hold at most ${MAX_IMPORT_ROWS} tasks` }],
    };
  }

  for (const record of records) {
    const data: Record<string, unknown> = {};
    let externalId: string | null = null;
    for (const [key, value] of Object.entries(record.data)) {
      if (ID_KEYS.includes(key) && externalId === null && !isBlank(value)) {
        externalId = String(value).trim();
      }
      if (!key.startsWith('_')) data[key] = value;
    }

    const missing = required.filter((field) => isBlank(data[field]));
    if (missing.length) {
      errors.push({ line: record.line, message: `Missing ${missing.join(', ')}` });
      continue;
    }
    if (schema.kind === 'bbox' && !isImageRef(data[schema.imageField])) {
      errors.push({
        line: record.line,
        message: `${schema.imageField} must be an http(s) URL or a path starting with /`,
      });
      continue;
    }
    if (externalId !== null) {
      const first = seenIds.get(externalId);
      if (first !== undefined) {
        errors.push({
          line: record.line,
          message: `Duplicate id ${externalId} (first on line ${first})`,
        });
        continue;
      }
      seenIds.set(externalId, record.line);
    }
    const rawGold = record.data[GOLD_KEY];
    if (!isBlank(rawGold)) {
      const gold = parseGold(schema, data, rawGold);
      if (!gold.ok) {
        errors.push({ line: record.line, message: `Gold answer: ${gold.error}` });
        continue;
      }
      rows.push({ line: record.line, externalId, data, gold: gold.answer });
      continue;
    }
    rows.push({ line: record.line, externalId, data });
  }

  if (records.length === 0 && errors.length === 0) {
    errors.push({ line: 0, message: 'The file has no tasks' });
  }
  return { format, rows, errors };
}
