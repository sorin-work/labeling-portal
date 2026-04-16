/**
 * Small CSV reader/writer (RFC 4180 style): comma separated, fields may be
 * wrapped in double quotes and then contain commas and line breaks.
 */

export type CsvTable = { header: string[]; rows: Array<{ line: number; values: string[] }> };

/** Splits CSV text into records. Each record remembers the line it started on. */
export function parseCsvRecords(text: string): Array<{ line: number; values: string[] }> {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: Array<{ line: number; values: string[] }> = [];
  let field = '';
  let values: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let sawAnything = false;

  const endRecord = () => {
    values.push(field);
    if (values.length > 1 || values[0] !== '') records.push({ line: recordLine, values });
    values = [];
    field = '';
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
    if (ch === '"') {
      inQuotes = true;
      sawAnything = true;
    } else if (ch === ',') {
      values.push(field);
      field = '';
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

export function parseCsv(text: string): CsvTable {
  const records = parseCsvRecords(text);
  if (records.length === 0) return { header: [], rows: [] };
  const [first, ...rest] = records;
  return { header: first.values.map((h) => h.trim()), rows: rest };
}

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialises rows to CSV text with a header line. */
export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>) {
  const lines = [header.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(row.map((value) => escapeField(value == null ? '' : String(value))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
