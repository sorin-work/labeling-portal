import { describe, expect, it } from 'vitest';

import { backupAttention, type BackupRunRow } from '~/domain/backups';

const now = new Date('2026-11-21T12:00:00Z');

function row(hoursAgo: number, ok: boolean, intervalSeconds = 86_400): BackupRunRow {
  return {
    finishedAt: new Date(now.getTime() - hoursAgo * 3_600_000),
    ok,
    file: ok ? 'labeling.dump' : null,
    message: ok ? null : 'pg_dump: error',
    intervalSeconds,
  };
}

describe('backupAttention', () => {
  it('is quiet without rows and while the newest good dump is recent', () => {
    expect(backupAttention(null, null, now)).toEqual([]);
    expect(backupAttention(row(35, true), row(35, true), now)).toEqual([]);
  });

  it('is late after one and a half intervals of the newest run', () => {
    expect(backupAttention(row(37, true), row(37, true), now)).toEqual([
      { kind: 'backup-late', hours: 37, lastGoodAt: row(37, true).finishedAt },
    ]);
    // an hourly service is late much sooner
    expect(backupAttention(row(2, true, 3600), row(2, true, 3600), now)).toHaveLength(1);
  });

  it('names a failure even while the good dump before it is recent', () => {
    expect(backupAttention(row(1, false), row(5, true), now)).toEqual([
      { kind: 'backup-failed', at: row(1, false).finishedAt, message: 'pg_dump: error' },
    ]);
  });
});
