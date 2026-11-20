import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { isSafeEntryName, MAX_ZIP_ENTRIES, ZipWriter } from '~/domain/zip';

function archive(files: Array<[string, string | Uint8Array]>, now = new Date()): Uint8Array {
  const zip = new ZipWriter(now);
  const parts = files.map(([name, content]) => zip.add(name, content));
  parts.push(zip.finish());
  return Buffer.concat(parts);
}

/**
 * Reads an archive back from its central directory, the way an unzip tool
 * does: every entry is found through the directory, and its content has to
 * match the size and checksum the directory gives.
 */
function readBack(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files: Record<string, string> = {};
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // the file's own header has to say the same as the directory
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    expect(view.getUint32(offset + 14, true)).toBe(crc);
    const start =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const body = bytes.subarray(start, start + packed);
    const raw = method === 8 ? inflateRawSync(body) : body;
    expect(raw.length).toBe(size);
    expect(crc32(raw)).toBe(crc);
    files[name] = decoder.decode(raw);
    at += 46 + nameLength;
  }
  expect(at).toBe(end);
  return files;
}

const hasPython = spawnSync('python3', ['--version']).status === 0;

describe('ZipWriter', () => {
  const files: Array<[string, string]> = [
    ['classes.txt', 'car\nperson\n'],
    ['labels/street-1.txt', '0 0.5 0.5 0.25 0.25\n'.repeat(40)],
    ['labels/empty.txt', ''],
    ['labels/ünïcode.txt', 'Zoë was here\n'],
  ];

  it('writes an archive that reads back to the same files', () => {
    expect(readBack(archive(files))).toEqual(Object.fromEntries(files));
  });

  it('stores what does not get smaller and deflates what does', () => {
    const bytes = archive(files);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // the first entry is short text, stored; the second repeats itself, deflated
    expect(view.getUint16(8, true)).toBe(0);
    const second = 30 + 'classes.txt'.length + 'car\nperson\n'.length;
    expect(view.getUint16(second + 8, true)).toBe(8);
    expect(bytes.length).toBeLessThan(files.reduce((sum, [, text]) => sum + text.length, 0));
  });

  // an independent reader: Python's zipfile checks every checksum
  it.skipIf(!hasPython)('is accepted by another zip implementation', () => {
    const folder = mkdtempSync(join(tmpdir(), 'zip-test-'));
    try {
      const path = join(folder, 'export.zip');
      writeFileSync(path, archive(files, new Date('2026-11-20T10:30:44Z')));
      const script = [
        'import json, sys, zipfile',
        'z = zipfile.ZipFile(sys.argv[1])',
        'print(json.dumps({"bad": z.testzip(), "files": {i.filename: z.read(i).decode() for i in z.infolist()}, "dates": sorted({i.date_time for i in z.infolist()})}))',
      ].join('\n');
      const out = JSON.parse(execFileSync('python3', ['-c', script, path], { encoding: 'utf8' }));
      expect(out.bad).toBeNull();
      expect(out.files).toEqual(Object.fromEntries(files));
      expect(out.dates).toEqual([[2026, 11, 20, 10, 30, 44]]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('refuses names that could land outside the folder an archive is unpacked in', () => {
    const unsafe = [
      '',
      '/etc/passwd',
      '../up.txt',
      'labels/../../up.txt',
      'labels/./x.txt',
      'labels//x.txt',
      'labels\\x.txt',
      'C:\\x.txt',
      'labels/x\u0000.txt',
      'trailing/',
      'a'.repeat(256),
    ];
    for (const name of unsafe) {
      expect(isSafeEntryName(name), name).toBe(false);
      expect(() => new ZipWriter().add(name, 'x'), name).toThrow(/Not a safe name/);
    }
    for (const name of ['a.txt', 'labels/a.txt', 'labels/..a.txt', 'a..b/c.txt']) {
      expect(isSafeEntryName(name), name).toBe(true);
    }
  });

  it('refuses a second entry with a name that only differs in case', () => {
    const zip = new ZipWriter();
    zip.add('labels/Cat.txt', 'x');
    expect(() => zip.add('labels/cat.txt', 'y')).toThrow(/already has an entry/);
  });

  it('refuses more files than the plain format can hold', () => {
    const zip = new ZipWriter();
    for (let i = 0; i < MAX_ZIP_ENTRIES; i++) zip.add(`f${i}`, '');
    expect(() => zip.add('one-too-many', '')).toThrow(/at most 65535 files/);
  });
});
