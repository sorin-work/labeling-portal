/**
 * Small CSV reader/writer (RFC 4180 style): fields are separated by a comma
 * (or another delimiter for reading), may be wrapped in double quotes and can
 * then contain the delimiter and line breaks.
 */

export type CsvTable = { header: string[]; rows: Array<{ line: number; values: string[] }> };

export type Delimiter = ',' | ';' | '\t';

/**
 * Tells a comma file from the semicolon files spreadsheet programs write in
 * many locales: whichever of the two splits the header line into more fields
 * wins, and a tie goes to the comma. Delimiters inside quotes do not count.
 */
export function sniffDelimiter(text: string): ',' | ';' {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (inQuotes) continue;
    else if (ch === '\n' || ch === '\r') break;
    else if (ch === ',') commas += 1;
    else if (ch === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

/** Splits CSV text into records. Each record remembers the line it started on. */
export function parseCsvRecords(
  text: string,
  delimiter: Delimiter = ',',
): Array<{ line: number; values: string[] }> {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: Array<{ line: number; values: string[] }> = [];
  let field = '';
  let values: string[] = [];
  let inQuotes = false;
  // a quote only opens a quoted field at the start of a field; in the middle
  // of one, as in `5" disk`, it is an ordinary character
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let sawAnything = false;

  const endRecord = () => {
    values.push(field);
    if (values.length > 1 || values[0] !== '') records.push({ line: recordLine, values });
    values = [];
    field = '';
    quoted = false;
    sawAnything = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"' && input[i + 1] === '"') {
        // a doubled quote inside a quoted field is a literal quote
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '' && !quoted) {
      inQuotes = true;
      quoted = true;
      sawAnything = true;
    } else if (ch === delimiter) {
      values.push(field);
      field = '';
      quoted = false;
      sawAnything = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      field += ch;
      sawAnything = true;
    }
  }
  if (sawAnything || field !== '' || values.length > 0) endRecord();
  return records;
}

export function parseCsv(text: string, delimiter: Delimiter = ','): CsvTable {
  const records = parseCsvRecords(text, delimiter);
  if (records.length === 0) return { header: [], rows: [] };
  const [first, ...rest] = records;
  return { header: first.values.map((h) => h.trim()), rows: rest };
}

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A spreadsheet program runs a cell that starts with = + - or @ (or a tab or
 * carriage return in front of one) as a formula, and exports hold text that
 * other people wrote. A single quote in front makes the cell plain text.
 * Text that already starts with quotes and then such a character gets one
 * more, so that taking one quote off again always gives the original back.
 * Only text is guarded: a number is passed as a number and written as it is.
 */
const NEEDS_GUARD = /^'*[=+\-@\t\r]/;
const IS_GUARDED = /^'+[=+\-@\t\r]/;

export function guardFormula(value: string): string {
  return NEEDS_GUARD.test(value) ? `'${value}` : value;
}

/** Takes the guard off again, for reading back a file this app exported. */
export function unguardFormula(value: string): string {
  return IS_GUARDED.test(value) ? value.slice(1) : value;
}

export type CsvCell = string | number | null | undefined;

/**
 * One CSV line, with its line ending. Text cells are guarded against being
 * run as formulas unless `formulas` is "keep", which is only right for a file
 * that is meant to be imported again as it is, like the example import file.
 */
export function toCsvLine(row: CsvCell[], formulas: 'guard' | 'keep' = 'guard'): string {
  const cells = row.map((value) => {
    if (value == null) return '';
    if (typeof value === 'number') return String(value);
    return escapeField(formulas === 'guard' ? guardFormula(value) : value);
  });
  return `${cells.join(',')}\r\n`;
}

/** Serialises rows to CSV text with a header line. */
export function toCsv(
  header: string[],
  rows: CsvCell[][],
  formulas: 'guard' | 'keep' = 'guard',
): string {
  return toCsvLine(header, formulas) + rows.map((row) => toCsvLine(row, formulas)).join('');
}
