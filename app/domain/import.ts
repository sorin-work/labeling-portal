import type { Answer } from './answers';
import { parseCsv, sniffDelimiter, unguardFormula, type Delimiter } from './csv';
import { parseGold } from './gold';
import { requiredFields, type TaskSchema } from './task-schema';

/**
 * Reading an uploaded file into tasks. Everything here is pure: bytes or text
 * go in, and either every row of the file comes out valid or a list of
 * problems does. Nothing is fetched, nothing is unpacked, and no row is
 * imported from a file that has a problem anywhere.
 */

export type ImportFormat = 'CSV' | 'TSV' | 'JSONL' | 'JSON';

export type ImportRow = {
  line: number;
  externalId: string | null;
  data: Record<string, unknown>;
  /** set for gold (honeypot) tasks */
  gold?: Answer;
};

/** `line` is 0 for a problem with the file as a whole. */
export type ImportError = { line: number; message: string };

export type ImportResult = {
  format: ImportFormat;
  /** what `line` counts: lines of the file, or items of a JSON array */
  unit: 'line' | 'item';
  rows: ImportRow[];
  errors: ImportError[];
};

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
/** How many problems a refusal lists before it only counts the rest. */
export const MAX_REPORTED_ERRORS = 20;

/** Columns/keys with a leading underscore are instructions to the importer, not task data. */
const ID_KEYS = ['_id', 'id'];
const GOLD_KEY = '_gold';

/**
 * A task's data as an annotator's browser gets it: without the id its row
 * was imported with. That id says where and when a task came from, and a
 * gold task copied from an older task would carry the older one's.
 */
export function withoutImportId(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !ID_KEYS.includes(key)));
}

type Decoded = { ok: true; text: string } | { ok: false; error: string };

function startsWith(bytes: Uint8Array, ...magic: number[]): boolean {
  return magic.every((byte, i) => bytes[i] === byte);
}

/**
 * Turns an upload into text, or says why it is not a file this reads. Archives
 * and compressed files are refused outright and never unpacked: a few
 * kilobytes of zip can hold gigabytes, and nothing here needs one.
 */
export function decodeUpload(bytes: Uint8Array): Decoded {
  if (bytes.length === 0) return { ok: false, error: 'The file is empty.' };
  if (bytes.length > MAX_IMPORT_BYTES) return { ok: false, error: 'Files can be at most 5 MB.' };
  if (startsWith(bytes, 0x50, 0x4b) || startsWith(bytes, 0x1f, 0x8b)) {
    return {
      ok: false,
      error:
        'Zip and gzip files are not read, and an .xlsx spreadsheet is a zip file. Export spreadsheets as CSV first.',
    };
  }
  if (startsWith(bytes, 0xff, 0xfe) || startsWith(bytes, 0xfe, 0xff)) {
    return { ok: false, error: 'The file is UTF-16 text. Save it as UTF-8 and upload it again.' };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      error:
        'That does not look like a CSV, TSV, JSON or JSON Lines file in UTF-8. Export spreadsheets as CSV first.',
    };
  }
  if (text.includes('\u0000')) {
    return {
      ok: false,
      error:
        'That does not look like a CSV, TSV, JSON or JSON Lines file. Export spreadsheets as CSV first.',
    };
  }
  return { ok: true, text };
}

/**
 * The format of a file, from its name first and its content otherwise. A
 * `.json` file is a JSON array when it starts with `[`, and JSON Lines when
 * it starts with `{`, which is what it was always taken for.
 */
export function detectFormat(filename: string, text: string): ImportFormat {
  const lower = filename.toLowerCase();
  const start = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimStart();
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'JSONL';
  if (lower.endsWith('.json')) return start.startsWith('[') ? 'JSON' : 'JSONL';
  if (lower.endsWith('.tsv') || lower.endsWith('.tab')) return 'TSV';
  if (lower.endsWith('.csv')) return 'CSV';
  if (start.startsWith('[')) return 'JSON';
  if (start.startsWith('{')) return 'JSONL';
  const header = start.split(/\r?\n/, 1)[0];
  return header.includes('\t') && !header.includes(',') && !header.includes(';') ? 'TSV' : 'CSV';
}

type RawRecord = {
  line: number;
  data: Record<string, unknown>;
  /** where the gold answer came from, when that is another line (a re-imported CSV export) */
  goldLine?: number;
};

/** How deep a value of an imported row may nest, counting the row itself as 1. */
export const MAX_JSON_DEPTH = 32;
/** How many values (keys and array items, at every level) one imported row may hold. */
export const MAX_JSON_VALUES = 10_000;

/**
 * Why a parsed value is too deep or too large to store, or null. JSON.parse
 * takes an array nested 200,000 deep, but the database client then runs out
 * of stack on it, so this is checked right after parsing, without recursion.
 */
export function jsonShapeProblem(value: unknown): string | null {
  const stack: Array<[unknown, number]> = [[value, 1]];
  let count = 0;
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (typeof current !== 'object' || current === null) continue;
    if (depth > MAX_JSON_DEPTH) return `Nested more than ${MAX_JSON_DEPTH} levels deep`;
    const children = Array.isArray(current) ? current : Object.values(current);
    count += children.length;
    if (count > MAX_JSON_VALUES) return `Holds more than ${MAX_JSON_VALUES} values`;
    for (const child of children) stack.push([child, depth + 1]);
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A line of this app's JSON Lines export: one task with its data, consensus
 * and annotations. It comes back as the task with its external id, and the
 * consensus as the task's gold answer. An empty multi-label consensus is not
 * an answer, so such a task comes back without one.
 */
function fromExportRecord(record: Record<string, unknown>): Record<string, unknown> | null {
  if (
    typeof record.task_id !== 'string' ||
    !isObject(record.data) ||
    !Array.isArray(record.annotations) ||
    !('consensus' in record)
  ) {
    return null;
  }
  const consensus = record.consensus;
  const empty = isObject(consensus) && Array.isArray(consensus.labels) && !consensus.labels.length;
  return {
    // first, so that it is the id that counts
    _id: record.external_id ?? null,
    ...record.data,
    ...(consensus == null || empty ? {} : { [GOLD_KEY]: consensus }),
  };
}

const NOT_JSON = 'Not valid JSON';
const NOT_OBJECT = 'Each line must be a JSON object';

function readJsonLines(text: string, errors: ImportError[]): RawRecord[] {
  const records: RawRecord[] = [];
  // editors on Windows like to start UTF-8 files with a byte order mark
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = index + 1;
    if (!raw.trim()) continue;
    // the limit is reported by the caller; no need to read the rest
    if (records.length > MAX_IMPORT_ROWS) break;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isObject(value)) {
        errors.push({ line, message: NOT_OBJECT });
        continue;
      }
      const problem = jsonShapeProblem(value);
      if (problem) {
        errors.push({ line, message: problem });
        continue;
      }
      records.push({ line, data: fromExportRecord(value) ?? value });
    } catch {
      errors.push({ line, message: NOT_JSON });
    }
  }
  if (
    records.length === 0 &&
    errors.length > 0 &&
    errors.every((e) => e.message === NOT_JSON || e.message === NOT_OBJECT)
  ) {
    // one JSON document spread over many lines fails on every line; say what it is
    try {
      const whole: unknown = JSON.parse(body);
      errors.length = 0;
      if (Array.isArray(whole)) return readJsonArray(body, errors);
      errors.push({
        line: 0,
        message: 'The file holds one JSON value, not one object per line',
      });
    } catch {
      // not one document either: the line errors stand
    }
  }
  return records;
}

function readJsonArray(text: string, errors: ImportError[]): RawRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    errors.push({ line: 0, message: 'The file is not valid JSON' });
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push({ line: 0, message: 'A JSON file must hold an array of objects, one per task' });
    return [];
  }
  const records: RawRecord[] = [];
  value.forEach((item: unknown, index) => {
    if (!isObject(item)) {
      errors.push({ line: index + 1, message: 'Each item must be a JSON object' });
      return;
    }
    const problem = jsonShapeProblem(item);
    if (problem) {
      errors.push({ line: index + 1, message: problem });
      return;
    }
    records.push({ line: index + 1, data: fromExportRecord(item) ?? item });
  });
  return records;
}

/** The columns that mark a CSV file as this app's own annotation export. */
const EXPORT_COLUMNS = ['task_id', 'annotator', 'answer', 'data'];

/**
 * This app's CSV export has a row per annotation and one for the consensus.
 * Read back, the rows of a task collapse into the task: its data from the
 * `data` column, and the answer of the consensus row as its gold answer.
 */
function readExportCsv(
  header: string[],
  rows: Array<{ line: number; values: string[] }>,
  errors: ImportError[],
): RawRecord[] {
  const column = (name: string) => header.indexOf(name);
  const tasks = new Map<string, RawRecord>();
  for (const row of rows) {
    const cell = (name: string) => row.values[column(name)] ?? '';
    const taskId = cell('task_id');
    let record = tasks.get(taskId);
    if (!record) {
      let data: unknown;
      try {
        data = JSON.parse(cell('data'));
      } catch {
        data = null;
      }
      if (!isObject(data)) {
        errors.push({ line: row.line, message: 'The data column does not hold a JSON object' });
        continue;
      }
      const problem = jsonShapeProblem(data);
      if (problem) {
        errors.push({ line: row.line, message: `The data column: ${problem}` });
        continue;
      }
      const externalId = unguardFormula(cell('external_id'));
      record = { line: row.line, data: { _id: externalId === '' ? null : externalId, ...data } };
      tasks.set(taskId, record);
    }
    if (cell('annotator') !== 'consensus') continue;
    try {
      const answer: unknown = JSON.parse(cell('answer'));
      const problem = jsonShapeProblem(answer);
      if (problem) {
        errors.push({ line: row.line, message: `The answer column: ${problem}` });
        continue;
      }
      const empty = isObject(answer) && Array.isArray(answer.labels) && !answer.labels.length;
      if (!empty) {
        record.data[GOLD_KEY] = answer;
        // a problem with it is reported on this row, not on the task's first one
        record.goldLine = row.line;
      }
    } catch {
      errors.push({ line: row.line, message: 'The answer column does not hold JSON' });
    }
  }
  return [...tasks.values()];
}

function readTable(text: string, delimiter: Delimiter, errors: ImportError[]): RawRecord[] {
  const records: RawRecord[] = [];
  const table = parseCsv(text, delimiter);
  if (table.openQuoteLine !== null) {
    // the field has taken in every line after it, rows and all
    errors.push({
      line: table.openQuoteLine,
      message: 'A quoted field starts here and is never closed',
    });
    return records;
  }
  if (table.header.length === 0) return records;
  const dupes = table.header.filter((h, i) => table.header.indexOf(h) !== i);
  if (dupes.length) {
    errors.push({ line: 1, message: `Duplicate column: ${dupes[0]}` });
    return records;
  }
  const complete: typeof table.rows = [];
  for (const row of table.rows) {
    if (row.values.length !== table.header.length) {
      errors.push({
        line: row.line,
        message: `Expected ${table.header.length} columns but found ${row.values.length}`,
      });
      continue;
    }
    complete.push(row);
  }
  if (EXPORT_COLUMNS.every((name) => table.header.includes(name))) {
    return readExportCsv(table.header, complete, errors);
  }
  for (const row of complete) {
    const data: Record<string, unknown> = {};
    table.header.forEach((key, i) => (data[key] = row.values[i]));
    records.push({ line: row.line, data });
  }
  return records;
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

/** An IPv4 address as four numbers, or null. The URL parser has already turned `0x7f.1` and the like into this form. */
function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((n) => n <= 255) ? numbers : null;
}

/** Loopback, private, shared, link-local, documentation, multicast and reserved IPv4 ranges. */
function isInternalIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** The eight 16-bit groups of an IPv6 address as the URL parser writes it (no brackets). */
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(':')) return null;
  const [head, tail] = host.includes('::') ? host.split('::') : [host, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === null && missing !== 0)) return null;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Only global unicast (2000::/3) is public. Inside it, documentation
 * (2001:db8::/32), Teredo (2001::/32) and 6to4 (2002::/16) are refused as
 * well, because the last two carry an IPv4 address that may be a private one.
 */
function isInternalIpv6(groups: number[]): boolean {
  const [first, second] = groups;
  if ((first & 0xe000) !== 0x2000) return true;
  return first === 0x2002 || (first === 0x2001 && (second === 0 || second === 0x0db8));
}

const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];

/**
 * Whether a host name points inside a network: a loopback, private,
 * link-local or reserved address written as an IP literal, a name without a
 * dot (`localhost`, `intranet`), or one under `.local` and the like. Names
 * are not looked up: the server never resolves or requests them.
 */
export function isInternalHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const v4 = ipv4(host);
  if (v4) return isInternalIpv4(v4);
  const v6 = ipv6Groups(host);
  if (v6) return isInternalIpv6(v6);
  if (host.includes(':')) return true;
  return !host.includes('.') || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Where a box project's image is. Either an absolute http or https URL, or a
 * path on the portal itself. The server never requests it: the address is
 * stored as text and only an annotator's browser loads it. Anything else
 * (`javascript:`, `data:`, `file:`, a `//host` address that borrows the
 * page's scheme) is refused. So are addresses inside a network (see
 * `isInternalHost`): every annotator's browser would request them, from
 * inside the annotator's own network. `allowedHosts` lists internal hosts the
 * installation serves images from on purpose (`INTERNAL_IMAGE_HOSTS`).
 */
export function isImageRef(value: unknown, allowedHosts: readonly string[] = []): boolean {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  if (!/^https?:\/\//i.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') return false;
  if (!isInternalHost(url.hostname)) return true;
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  return allowedHosts.some((allowed) => allowed === host);
}

export type ImportOptions = {
  /** the rows are qualification test questions: every one needs a gold answer */
  qualification?: boolean;
  /** internal image hosts this installation allows, lower case (`INTERNAL_IMAGE_HOSTS`) */
  internalImageHosts?: readonly string[];
};

/** Parses an uploaded file into task rows, collecting every problem with its line number. */
export function parseImport(
  text: string,
  format: ImportFormat,
  schema: TaskSchema,
  options: ImportOptions = {},
): ImportResult {
  const errors: ImportError[] = [];
  const unit = format === 'JSON' ? 'item' : 'line';
  const records =
    format === 'JSONL'
      ? readJsonLines(text, errors)
      : format === 'JSON'
        ? readJsonArray(text, errors)
        : readTable(text, format === 'TSV' ? '\t' : sniffDelimiter(text), errors);
  const rows: ImportRow[] = [];
  const seenIds = new Map<string, number>();
  const required = requiredFields(schema);

  if (records.length > MAX_IMPORT_ROWS) {
    return {
      format,
      unit,
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
    if (
      schema.kind === 'bbox' &&
      !isImageRef(data[schema.imageField], options.internalImageHosts)
    ) {
      errors.push({
        line: record.line,
        message: `${schema.imageField} must be a public http(s) URL or a path starting with /`,
      });
      continue;
    }
    if (externalId !== null) {
      const first = seenIds.get(externalId);
      if (first !== undefined) {
        errors.push({
          line: record.line,
          message: `Duplicate id ${externalId} (first on ${unit} ${first})`,
        });
        continue;
      }
      seenIds.set(externalId, record.line);
    }
    const rawGold = record.data[GOLD_KEY];
    if (!isBlank(rawGold)) {
      // the same checks an annotator's answer gets, against the schema as it is now
      const gold = parseGold(schema, data, rawGold);
      if (!gold.ok) {
        errors.push({
          line: record.goldLine ?? record.line,
          message: `Gold answer: ${gold.error}`,
        });
        continue;
      }
      rows.push({ line: record.line, externalId, data, gold: gold.answer });
      continue;
    }
    if (options.qualification) {
      errors.push({ line: record.line, message: 'Qualification questions need a _gold answer' });
      continue;
    }
    rows.push({ line: record.line, externalId, data });
  }

  if (records.length === 0 && errors.length === 0) {
    errors.push({ line: 0, message: 'The file has no tasks' });
  }
  errors.sort((a, b) => a.line - b.line);
  return { format, unit, rows, errors };
}

export type ImportOutcome =
  | { ok: true; format: ImportFormat; rows: ImportRow[] }
  | {
      ok: false;
      /** one sentence for the top of the page */
      message: string;
      /** the first problems, in file order */
      errors: ImportError[];
      /** how many problems there are beyond the listed ones */
      more: number;
      unit: 'line' | 'item';
      /** rows that had no problem, to show how far the file is from importing */
      validRows: number;
    };

/**
 * The whole way from an upload to tasks. A file is imported completely or not
 * at all: one problem anywhere refuses it, and the refusal lists the first
 * problems and counts the rest.
 */
export function readImportFile(
  bytes: Uint8Array,
  filename: string,
  schema: TaskSchema,
  options: ImportOptions = {},
): ImportOutcome {
  const decoded = decodeUpload(bytes);
  if (!decoded.ok) {
    return { ok: false, message: decoded.error, errors: [], more: 0, unit: 'line', validRows: 0 };
  }
  const format = detectFormat(filename, decoded.text);
  const result = parseImport(decoded.text, format, schema, options);
  if (result.errors.length === 0) return { ok: true, format, rows: result.rows };
  return {
    ok: false,
    message:
      result.rows.length === 0
        ? 'No valid tasks were found in the file.'
        : 'Nothing was imported: some rows have problems. Fix them and upload the file again.',
    errors: result.errors.slice(0, MAX_REPORTED_ERRORS),
    more: Math.max(0, result.errors.length - MAX_REPORTED_ERRORS),
    unit: result.unit,
    validRows: result.rows.length,
  };
}
