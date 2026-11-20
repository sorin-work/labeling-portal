#!/bin/sh
# Checks the parts of backup.sh that can lose data when they go wrong: the
# daily loop, the pruning, and the one step of a restore that cannot be taken
# back. No database is needed. pg_dump, psql and sleep are replaced by
# stand-ins, so every case takes a moment, and dump files with made-up dates
# stand for clocks that were wrong or were changed.
#
# For the loop: it runs for a number of rounds, makes at most one dump,
# pauses after every attempt, and never leaves fewer dumps behind than
# BACKUP_KEEP allows.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

ROUNDS=12
DAY=86400
now=$(date +%s)
# Two days from now, in the form touch takes.
AHEAD=$(date -u -d "@$((now + 2 * DAY))" '+%Y-%m-%d %H:%M:%S')

mkdir "$work/bin"

# Writes the file pg_dump was asked for, unless the case wants it to fail.
# With "fast-clock" the file gets a modification time in the future, as if
# the folder were on a machine whose clock runs ahead.
cat >"$work/bin/pg_dump" <<'STUB'
#!/bin/sh
echo attempt >>"$STATE/attempts"
[ ! -e "$STATE/fail" ] || exit 1
for arg in "$@"; do
  case $arg in
    --file=*)
      echo "new" >"${arg#--file=}"
      [ ! -e "$STATE/fast-clock" ] || touch -d "$AHEAD" "${arg#--file=}"
      ;;
  esac
done
STUB

# The loop asks psql how many tables there are: none with "no-tables", as on
# a new stack before the app has applied the migrations. A restore uses psql
# for the rename at the end, which the last case lets fail.
cat >"$work/bin/psql" <<'STUB'
#!/bin/sh
case "$*" in
  *"RENAME TO"*) [ ! -e "$STATE/rename-fails" ] || exit 1 ;;
  *) if [ -e "$STATE/no-tables" ]; then echo 0; else echo 9; fi ;;
esac
STUB

# The rest of what a restore calls. All of it works.
for tool in dropdb createdb pg_restore; do
  printf '#!/bin/sh\nexit 0\n' >"$work/bin/$tool"
  chmod +x "$work/bin/$tool"
done

# Returns at once and stops the loop, its parent, after $ROUNDS naps.
cat >"$work/bin/sleep" <<'STUB'
#!/bin/sh
echo "$1" >>"$STATE/naps"
if [ "$(wc -l <"$STATE/naps")" -ge "$ROUNDS" ]; then
  kill -TERM "$PPID"
fi
STUB
chmod +x "$work/bin/pg_dump" "$work/bin/psql" "$work/bin/sleep"

fail() {
  echo "FAILED ($case_name): $*" >&2
  echo "--- dumps" >&2
  ls -l "$BACKUP_DIR" >&2
  echo "--- log" >&2
  cat "$STATE/log" >&2
  exit 1
}

# A dump file dated $1 seconds from now (negative for the past).
old_dump() {
  name="labeling-$(date -u -d "@$((now + $1))" +%Y%m%dT%H%M%SZ).dump"
  echo "old" >"$BACKUP_DIR/$name"
  echo "$name"
}

begin() {
  case_name=$1
  STATE="$work/state"
  BACKUP_DIR="$work/dumps"
  rm -rf "$STATE" "$BACKUP_DIR"
  mkdir "$STATE" "$BACKUP_DIR"
  : >"$STATE/attempts"
  : >"$STATE/naps"
  export STATE BACKUP_DIR ROUNDS AHEAD
  export BACKUP_KEEP=3 BACKUP_INTERVAL_SECONDS=$DAY PGDATABASE=labeling
}

# Runs the loop until the stand-in for sleep stops it. The timeout is for a
# loop that never pauses at all.
run_loop() {
  status=0
  PATH="$work/bin:$PATH" timeout 30 sh "$here/backup.sh" >"$STATE/log" 2>&1 || status=$?
  [ "$status" -eq 0 ] || fail "the loop did not stop by itself (exit $status), so it ran without pausing"
}

count() {
  wc -l <"$1" | tr -d ' '
}

dump_count() {
  ls "$BACKUP_DIR" | grep -c '\.dump$' || true
}

# $1: how many dumps the loop should have made, $2: how many files to find.
expect() {
  attempts=$(count "$STATE/attempts")
  [ "$attempts" -eq "$1" ] || fail "expected $1 dump(s) to be made, saw $attempts"
  [ "$(dump_count)" -eq "$2" ] || fail "expected $2 dump files, found $(dump_count)"
  [ "$(count "$STATE/naps")" -ge "$ROUNDS" ] || fail "the loop stopped before $ROUNDS pauses"
  echo "ok: $case_name"
}

begin "no dumps yet: one dump, then it waits"
run_loop
expect 1 1

begin "a new stack without tables: it waits and dumps nothing"
touch "$STATE/no-tables"
run_loop
expect 0 0
grep -q "has no tables yet" "$STATE/log" || fail "the log does not say what it is waiting for"

begin "newest dump two days old: one dump, the oldest goes"
oldest=$(old_dump $((-4 * DAY)))
old_dump $((-3 * DAY)) >/dev/null
old_dump $((-2 * DAY)) >/dev/null
run_loop
expect 1 3
[ ! -e "$BACKUP_DIR/$oldest" ] || fail "the oldest dump was kept"

begin "newest dump an hour old: nothing to do"
old_dump $((-2 * DAY)) >/dev/null
old_dump $((-1 * DAY)) >/dev/null
old_dump -3600 >/dev/null
run_loop
expect 0 3

begin "modification times in the future, as on a share with a fast clock"
old_dump $((-2 * DAY)) >/dev/null
old_dump $((-1 * DAY)) >/dev/null
old_dump -3600 >/dev/null
touch -d "$AHEAD" "$BACKUP_DIR"/*.dump
touch "$STATE/fast-clock"
run_loop
expect 0 3

begin "the same share, with a dump that is due: one dump, not one per round"
old_dump $((-4 * DAY)) >/dev/null
old_dump $((-3 * DAY)) >/dev/null
old_dump $((-2 * DAY)) >/dev/null
touch -d "$AHEAD" "$BACKUP_DIR"/*.dump
touch "$STATE/fast-clock"
run_loop
expect 1 3

begin "every dump dated in the future, after the clock was set back"
old_dump $((1 * DAY)) >/dev/null
old_dump $((2 * DAY)) >/dev/null
old_dump $((3 * DAY)) >/dev/null
run_loop
expect 0 3
grep -q "dated in the future" "$STATE/log" || fail "the log does not mention the dates"

begin "dumps dated in the future next to an overdue one"
overdue=$(old_dump $((-2 * DAY)))
old_dump $((2 * DAY)) >/dev/null
old_dump $((3 * DAY)) >/dev/null
run_loop
expect 1 3
[ ! -e "$BACKUP_DIR/$overdue" ] || fail "the overdue dump was kept instead of the new one"
grep -lq new "$BACKUP_DIR"/*.dump || fail "the dump that was just written was pruned"

begin "pg_dump fails: a pause after every attempt, nothing removed"
old_dump $((-4 * DAY)) >/dev/null
old_dump $((-3 * DAY)) >/dev/null
old_dump $((-2 * DAY)) >/dev/null
touch "$STATE/fail"
run_loop
[ "$(dump_count)" -eq 3 ] || fail "expected the 3 old dumps to be left alone, found $(dump_count)"
[ "$(count "$STATE/attempts")" -le "$(count "$STATE/naps")" ] || fail "two attempts without a pause in between"
[ -z "$(ls -A "$BACKUP_DIR" | grep '\.partial$' || true)" ] || fail "a partial dump was left behind"
echo "ok: $case_name"

begin "once, with every other dump dated in the future: the new dump stays"
old_dump $((1 * DAY)) >/dev/null
old_dump $((2 * DAY)) >/dev/null
old_dump $((3 * DAY)) >/dev/null
PATH="$work/bin:$PATH" sh "$here/backup.sh" once >"$STATE/log" 2>&1 || fail "once failed"
[ "$(dump_count)" -eq 3 ] || fail "expected 3 dump files, found $(dump_count)"
grep -lq new "$BACKUP_DIR"/*.dump || fail "the dump that was just written was pruned"
echo "ok: $case_name"

begin "restore: the rename fails after the drop"
dump=$(old_dump -3600)
touch "$STATE/rename-fails"
status=0
PATH="$work/bin:$PATH" PGUSER=labeling sh "$here/backup.sh" restore "$dump" >"$STATE/log" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "the restore reported success"
grep -q "the data from $dump is in the database labeling_restoring" "$STATE/log" || fail "it does not say where the data is"
finish="psql -U labeling -d postgres -c 'ALTER DATABASE \"labeling_restoring\" RENAME TO \"labeling\"'"
grep -q -F "$finish" "$STATE/log" || fail "it does not print the command that finishes the restore"
grep -q "Leave the app stopped" "$STATE/log" || fail "it does not say to leave the app stopped"
echo "ok: $case_name"

echo "OK: the loop, the pruning and the restore held in every case"
