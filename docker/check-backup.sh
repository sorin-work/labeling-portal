#!/bin/sh
# Proves that the dumps backup.sh makes can be restored. Runs in the postgres
# image, against a database nothing else is writing to. CI points it at the
# test database once the tests are done and the demo data has been put in.
#
#   1. check-backup-loop.sh: the daily loop, the pruning and a restore that
#      fails half way, with stand-ins for the database tools.
#   2. Three real dumps with BACKUP_KEEP=2 leave the two newest, and leave
#      files that are not dumps alone.
#   3. The newest dump restores into a scratch database.
#   4. Every table has the same number of rows in both, and the application
#      tables are not all empty.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
scratch="${PGDATABASE}_restore_check"
work=$(mktemp -d)

cleanup() {
  rm -rf "$work"
  dropdb --if-exists "$scratch" >/dev/null 2>&1 || true
  dropdb --if-exists "${scratch}_restoring" >/dev/null 2>&1 || true
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

echo "== restore $newest into $scratch"
PGDATABASE="$scratch" sh "$here/backup.sh" restore "$newest"

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
