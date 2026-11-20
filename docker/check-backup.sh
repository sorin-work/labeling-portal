#!/bin/sh
# Proves that the dumps backup.sh makes can be restored. Runs in the postgres
# image, against a database nothing else is writing to. CI points it at the
# test database once the tests are done and the demo data has been put in.
#
#   1. check-backup-loop.sh: the daily loop, the pruning and the restore, with
#      stand-ins for the database tools.
#   2. Three real dumps with BACKUP_KEEP=2 leave the two newest, and leave
#      files that are not dumps alone.
#   3. A scratch database with other data in it is the one to be replaced. A
#      damaged dump, and a restore while something is connected, must both
#      leave it exactly as it was.
#   4. The newest dump then replaces it: the other data is gone, every table
#      has the same number of rows as the source, and the application tables
#      are not all empty.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
scratch="${PGDATABASE}_restore_check"
work=$(mktemp -d)

sleeper=''

cleanup() {
  [ -z "$sleeper" ] || kill "$sleeper" 2>/dev/null || true
  rm -rf "$work"
  for name in "$scratch" "${scratch}_restoring" "${scratch}_replaced" "${scratch}_a" "${scratch}_b"; do
    dropdb --if-exists --force "$name" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

fail() {
  echo "FAILED: $*" >&2
  exit 1
}

# One "schema.table rows" line per table.
row_counts() {
  psql -AtXq -F ' ' -v ON_ERROR_STOP=1 -d "$1" <<'SQL'
select format('select %L, count(*) from %I.%I', schemaname || '.' || tablename, schemaname, tablename)
from pg_tables
where schemaname not in ('pg_catalog', 'information_schema')
order by schemaname, tablename
\gexec
SQL
}

echo "== loop, pruning and restore with stand-ins"
sh "$here/check-backup-loop.sh"

export BACKUP_DIR="$work/dumps" BACKUP_KEEP=2
mkdir "$BACKUP_DIR"
echo "not a dump" >"$BACKUP_DIR/keep-me.txt"

echo "== retention"
sh "$here/backup.sh" once
first=$(ls "$BACKUP_DIR" | grep '\.dump$')
# Dump names have a resolution of one second.
sleep 1
sh "$here/backup.sh" once
sleep 1
sh "$here/backup.sh" once

left=$(ls "$BACKUP_DIR" | grep '\.dump$' | sort)
[ "$(echo "$left" | wc -l)" -eq 2 ] || fail "expected 2 dumps to be kept, found: $left"
if echo "$left" | grep -qx "$first"; then
  fail "the oldest dump ($first) was kept"
fi
[ -f "$BACKUP_DIR/keep-me.txt" ] || fail "a file that is not a dump was removed"
[ -z "$(ls -A "$BACKUP_DIR" | grep '\.partial$' || true)" ] || fail "a partial dump was left behind"
newest=$(echo "$left" | tail -n 1)
mode=$(stat -c %a "$BACKUP_DIR/$newest")
[ "$mode" = 600 ] || fail "$newest has mode $mode, it should be readable by its owner only"

# The database that is going to be replaced, with data of its own.
marker_rows() {
  psql -AtXq -d "$scratch" -c "select count(*) from restore_check_marker" 2>/dev/null || echo gone
}

# Every database the restore may have made or left behind.
databases() {
  psql -AtXq -d postgres -c "select datname from pg_database where datname like '${scratch}%' order by 1" | tr '\n' ' '
}

sessions() {
  psql -AtXq -d postgres -c "select count(*) from pg_stat_activity where datname = '$scratch'"
}

# After a restore that had to fail: $1 is its log.
expect_untouched() {
  [ "$(marker_rows)" = 3 ] || fail "the database that was to be replaced lost its data: $(marker_rows) rows left"
  [ "$(databases)" = "$scratch " ] || fail "databases left behind: $(databases)"
  grep -q "$scratch was left as it was" "$1" || fail "the message does not say that $scratch was left as it was"
}

echo "== a database with other data, to be replaced"
createdb "$scratch"
psql -qX -v ON_ERROR_STOP=1 -d "$scratch" -c "create table restore_check_marker (id int)" -c "insert into restore_check_marker values (1), (2), (3)"

echo "== a damaged dump leaves it alone"
head -c 2000 "$BACKUP_DIR/$newest" >"$work/damaged.dump"
if PGDATABASE="$scratch" sh "$here/backup.sh" restore "$work/damaged.dump" >"$work/damaged.log" 2>&1; then
  fail "a damaged dump was restored"
fi
expect_untouched "$work/damaged.log"

echo "== a restore is refused while something is connected"
PGAPPNAME=restore-check-session psql -qX -d "$scratch" -c "select pg_sleep(300)" >/dev/null 2>&1 &
sleeper=$!
tries=0
until [ "$(sessions)" = 1 ]; do
  tries=$((tries + 1))
  [ "$tries" -lt 100 ] || fail "the session that should block the restore never showed up"
  sleep 0.1
done
if PGDATABASE="$scratch" sh "$here/backup.sh" restore "$newest" >"$work/busy.log" 2>&1; then
  fail "the database was replaced while a session was connected to it"
fi
expect_untouched "$work/busy.log"
grep -q "Still connected to it: restore-check-session (1)" "$work/busy.log" || fail "the message does not say who is connected: $(cat "$work/busy.log")"
psql -AtXq -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$scratch'" >/dev/null
wait "$sleeper" 2>/dev/null || true
sleeper=''
until [ "$(sessions)" = 0 ]; do sleep 0.1; done

echo "== the server takes back a swap that fails half way"
# What the restore relies on: renaming a database can be rolled back.
createdb "${scratch}_a"
if psql -qX -v ON_ERROR_STOP=1 --single-transaction -d postgres \
  -c "ALTER DATABASE \"${scratch}_a\" RENAME TO \"${scratch}_b\"" \
  -c "ALTER DATABASE \"${scratch}_missing\" RENAME TO \"${scratch}_a\"" >/dev/null 2>&1; then
  fail "renaming a database that does not exist worked"
fi
[ "$(databases)" = "$scratch ${scratch}_a " ] || fail "the first rename was not taken back: $(databases)"
dropdb "${scratch}_a"

echo "== restore $newest in the place of $scratch"
PGDATABASE="$scratch" sh "$here/backup.sh" restore "$newest"
[ "$(marker_rows)" = gone ] || fail "the old data is still there: the dump was loaded on top of it"
[ "$(databases)" = "$scratch " ] || fail "databases left behind: $(databases)"

echo "== row counts"
row_counts "$PGDATABASE" >"$work/source.txt"
row_counts "$scratch" >"$work/restored.txt"
cat "$work/source.txt"
diff "$work/source.txt" "$work/restored.txt" || fail "row counts differ between $PGDATABASE (-) and the restored copy (+)"
# Prisma's own table always has rows. Only the application's tables say
# whether there was anything to lose.
total=$(awk '$1 !~ /\._prisma_migrations$/ { rows += $2 } END { print rows + 0 }' "$work/source.txt")
[ "$total" -gt 0 ] || fail "the application tables of $PGDATABASE are empty, so this proves nothing"

echo "OK: $(wc -l <"$work/source.txt") tables came back from $newest, $total rows in the application tables"
