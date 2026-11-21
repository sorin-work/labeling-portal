/**
 * What the admin hears about backups, from the rows `docker/backup.sh` writes
 * to `BackupRun` after each attempt. Nothing is said before the service has
 * written its first row, so a stack without the backup profile is not warned.
 */

/** A dump is late once the newest good one is this many intervals old. */
export const LATE_AFTER_INTERVALS = 1.5;

export type BackupRunRow = {
  finishedAt: Date;
  ok: boolean;
  file: string | null;
  message: string | null;
  intervalSeconds: number;
};

export type BackupAttention =
  | { kind: 'backup-failed'; at: Date; message: string | null }
  /** `hours` is null when no dump has worked yet */
  | { kind: 'backup-late'; hours: number | null; lastGoodAt: Date | null };

/**
 * `latest` is the newest run, `lastGood` the newest one that worked. The
 * interval is the one the newest run was made with, since that is how often
 * the service dumps now.
 */
export function backupAttention(
  latest: BackupRunRow | null,
  lastGood: BackupRunRow | null,
  now: Date,
): BackupAttention[] {
  if (!latest) return [];
  const items: BackupAttention[] = [];
  if (!latest.ok)
    items.push({ kind: 'backup-failed', at: latest.finishedAt, message: latest.message });
  if (!lastGood) {
    items.push({ kind: 'backup-late', hours: null, lastGoodAt: null });
    return items;
  }
  const age = now.getTime() - lastGood.finishedAt.getTime();
  if (age > latest.intervalSeconds * 1000 * LATE_AFTER_INTERVALS) {
    items.push({
      kind: 'backup-late',
      hours: Math.floor(age / 3_600_000),
      lastGoodAt: lastGood.finishedAt,
    });
  }
  return items;
}
