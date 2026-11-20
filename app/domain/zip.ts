import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A zip writer for many small files, written to as a stream: `add` returns
 * the bytes of one file, ready to send, and `finish` the directory that
 * closes the archive. Only the directory is kept in memory.
 *
 * It writes the plain format, without the zip64 extension, so an archive
 * holds at most 65,535 files and 4 GB.
 */

export const MAX_ZIP_ENTRIES = 65_535;
const MAX_ZIP_BYTES = 0xffffffff;

const encoder = new TextEncoder();

type Entry = {
  name: Uint8Array;
  method: 0 | 8;
  crc: number;
  packed: number;
  size: number;
  offset: number;
};

/**
 * A path inside the archive that cannot land outside the folder it is
 * unpacked in: relative, forward slashes only, no `.` or `..` part.
 */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.length > 255 || name.includes('\\')) return false;
  // no control characters, which includes the NUL some tools cut a name at
  if ([...name].some((ch) => ch.charCodeAt(0) < 0x20)) return false;
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export class ZipWriter {
  private readonly entries: Entry[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private readonly time: number;
  private readonly date: number;

  constructor(now = new Date()) {
    // MS-DOS format, the only one the plain zip header has: two-second steps
    this.time = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1);
    this.date =
      (Math.max(0, now.getUTCFullYear() - 1980) << 9) |
      ((now.getUTCMonth() + 1) << 5) |
      now.getUTCDate();
  }

  /** The header fields a file's own header and its directory entry share. */
  private common(view: DataView, at: number, entry: Entry) {
    view.setUint16(at, 20, true); // version needed: 2.0, for deflate
    view.setUint16(at + 2, 0x0800, true); // names are UTF-8
    view.setUint16(at + 4, entry.method, true);
    view.setUint16(at + 6, this.time, true);
    view.setUint16(at + 8, this.date, true);
    view.setUint32(at + 10, entry.crc, true);
    view.setUint32(at + 14, entry.packed, true);
    view.setUint32(at + 18, entry.size, true);
    view.setUint16(at + 22, entry.name.length, true);
  }

  /** One file: its header followed by its content, deflated when that is smaller. */
  add(name: string, content: string | Uint8Array): Uint8Array {
    if (!isSafeEntryName(name)) throw new Error(`Not a safe name for a zip entry: ${name}`);
    const key = name.toLowerCase();
    if (this.names.has(key)) throw new Error(`The zip already has an entry named ${name}`);
    if (this.entries.length >= MAX_ZIP_ENTRIES) {
      throw new Error(`A zip holds at most ${MAX_ZIP_ENTRIES} files`);
    }
    this.names.add(key);

    const raw = typeof content === 'string' ? encoder.encode(content) : content;
    const deflated = deflateRawSync(raw);
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const entry: Entry = {
      name: encoder.encode(name),
      method: stored ? 0 : 8,
      crc: crc32(raw),
      packed: body.length,
      size: raw.length,
      offset: this.offset,
    };
    const bytes = new Uint8Array(30 + entry.name.length + body.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x04034b50, true);
    this.common(view, 4, entry);
    bytes.set(entry.name, 30);
    bytes.set(body, 30 + entry.name.length);

    this.offset += bytes.length;
    if (this.offset > MAX_ZIP_BYTES) throw new Error('The zip would be larger than 4 GB');
    this.entries.push(entry);
    return bytes;
  }

  /** The central directory and the record that ends the archive. */
  finish(): Uint8Array {
    const size = this.entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
    if (this.offset + size > MAX_ZIP_BYTES) throw new Error('The zip would be larger than 4 GB');
    const bytes = new Uint8Array(size + 22);
    const view = new DataView(bytes.buffer);
    let at = 0;
    for (const entry of this.entries) {
      view.setUint32(at, 0x02014b50, true);
      view.setUint16(at + 4, 20, true); // made by: 2.0
      this.common(view, at + 6, entry);
      // extra field, comment, disk number and file attributes stay 0
      view.setUint32(at + 42, entry.offset, true);
      bytes.set(entry.name, at + 46);
      at += 46 + entry.name.length;
    }
    view.setUint32(at, 0x06054b50, true);
    view.setUint16(at + 8, this.entries.length, true);
    view.setUint16(at + 10, this.entries.length, true);
    view.setUint32(at + 12, size, true);
    view.setUint32(at + 16, this.offset, true);
    return bytes;
  }
}
