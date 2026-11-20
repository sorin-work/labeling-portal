#!/bin/sh
# Checks the parts of backup.sh that can lose data when they go wrong: the
# daily loop, the pruning, and the restore. No database is needed. pg_dump,
# psql, pg_restore, createdb, dropdb and sleep are replaced by stand-ins, so
# every case takes a moment, and dump files with made-up dates stand for
# clocks that were wrong or were changed.
#
# For the loop: it runs for a number of rounds, makes at most one dump,
# pauses after every attempt, and never leaves fewer dumps behind than
# BACKUP_KEEP allows.
#
# For the restore: the stand-ins keep a pretend set of databases, one file
# each under $STATE/dbs, and every case says what must be in the database
# afterwards. A restore that fails must leave it exactly as it was.
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

# psql has three jobs. The loop asks how many tables there are: none with
# "no-tables", as on a new stack before the app has applied the migrations.
# A restore asks whether a database exists and who is connected to one. And
# a restore renames databases, which this does to the pretend set the way the
# server would: a rename fails when the database is missing, when the new
# name is taken, or when the case wants the n-th rename to fail
# ("fail-rename"). With --single-transaction a failure takes back the renames
# before it. Without, each one stays done, as it would on the server.
cat >"$work/bin/psql" <<'STUB'
#!/bin/sh
echo "psql $*" >>"$STATE/calls"
case "$*" in
  *"RENAME TO"*)
    single=no
    for arg in "$@"; do
      [ "$arg" != --single-transaction ] || single=yes
    done
    rm -rf "$STATE/next"
    cp -r "$STATE/dbs" "$STATE/next"
    finish() {
      rm -rf "$STATE/dbs"
      mv "$STATE/next" "$STATE/dbs"
    }
    for arg in "$@"; do
      case $arg in
        *"RENAME TO"*)
          from=$(echo "$arg" | sed -E 's/^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"$/\1/')
          to=$(echo "$arg" | sed -E 's/^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"$/\2/')
          n=$(($(cat "$STATE/renames" 2>/dev/null || echo 0) + 1))
          echo "$n" >"$STATE/renames"
          if [ ! -e "$STATE/next/$from" ] || [ -e "$STATE/next/$to" ] ||
            [ "$(cat "$STATE/fail-rename" 2>/dev/null)" = "$n" ]; then
            if [ "$single" = yes ]; then rm -rf "$STATE/next"; else finish; fi
            echo "psql: could not rename $from to $to" >&2
            exit 3
          fi
          mv "$STATE/next/$from" "$STATE/next/$to"
          ;;
      esac
    done
    finish
    ;;
  *pg_database*)
    name=$(echo "$*" | sed -E "s/.*datname = '([^']+)'.*/\1/")
    [ ! -e "$STATE/dbs/$name" ] || echo 1
    ;;
  *pg_stat_activity*)
    cat "$STATE/sessions" 2>/dev/null || true
    ;;
  *)
    if [ -e "$STATE/no-tables" ]; then echo 0; else echo 9; fi
    ;;
esac
STUB

# createdb makes an empty pretend database, dropdb removes one. The name is
# the last argument. "drop-fails-<name>" makes dropping that database fail.
cat >"$work/bin/createdb" <<'STUB'
#!/bin/sh
echo "createdb $*" >>"$STATE/calls"
for name in "$@"; do :; done
[ ! -e "$STATE/dbs/$name" ] || exit 1
echo "empty" >"$STATE/dbs/$name"
STUB

cat >"$work/bin/dropdb" <<'STUB'
#!/bin/sh
echo "dropdb $*" >>"$STATE/calls"
for name in "$@"; do :; done
[ -e "$STATE/dbs/$name" ] || exit 0
[ ! -e "$STATE/drop-fails-$name" ] || exit 1
rm -f "$STATE/dbs/$name"
STUB

# pg_restore fills the database it is given. With "restore-fails" it stops
# half way, as it does on a damaged dump, and leaves the half behind.
cat >"$work/bin/pg_restore" <<'STUB'
#!/bin/sh
echo "pg_restore $*" >>"$STATE/calls"
for arg in "$@"; do
  case $arg in
    --dbname=*) db=${arg#--dbname=} ;;
  esac
  file=$arg
done
echo "half of $(basename "$file")" >"$STATE/dbs/$db"
[ ! -e "$STATE/restore-fails" ] || exit 1
echo "restored from $(basename "$file")" >"$STATE/dbs/$db"
STUB

# Returns at once and stops the loop, its parent, after $ROUNDS naps.
cat >"$work/bin/sleep" <<'STUB'
#!/bin/sh
echo "$1" >>"$STATE/naps"
if [ "$(wc -l <"$STATE/naps")" -ge "$ROUNDS" ]; then
  kill -TERM "$PPID"
fi
STUB
chmod +x "$work/bin"/*

fail() {
  echo "FAILED ($case_name): $*" >&2
  echo "--- dumps" >&2
  ls -l "$BACKUP_DIR" >&2
  echo "--- databases" >&2
  grep -r . "$STATE/dbs" >&2 || true
  echo "--- calls" >&2
  cat "$STATE/calls" >&2
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
  mkdir "$STATE" "$STATE/dbs" "$BACKUP_DIR"
  : >"$STATE/attempts"
  : >"$STATE/naps"
  : >"$STATE/calls"
  : >"$STATE/log"
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

begin "dumps dated in the future next to an overdue one: a dump, and nothing goes"
overdue=$(old_dump $((-2 * DAY)))
ahead_one=$(old_dump $((2 * DAY)))
ahead_two=$(old_dump $((3 * DAY)))
run_loop
# the two that are not dated in the future are within the three to keep
expect 1 4
[ -e "$BACKUP_DIR/$overdue" ] || fail "a real dump was removed to make room for dumps dated in the future"
grep -lq new "$BACKUP_DIR"/*.dump || fail "the dump that was just written was pruned"
grep "WARNING" "$STATE/log" | grep -F "$ahead_one" | grep -q -F "$ahead_two" ||
  fail "the log does not name the dumps dated in the future"

begin "a week with the clock a year ahead: the stale dumps do not push the real ones out"
stale=''
for day in 1 2 3 4 5 6; do
  stale="$stale $(old_dump $(((365 + day) * DAY)))"
done
oldest=$(old_dump $((-4 * DAY)))
kept_one=$(old_dump $((-3 * DAY)))
kept_two=$(old_dump $((-2 * DAY)))
run_loop
# six stale ones stay, and the real ones get all three places
expect 1 9
[ ! -e "$BACKUP_DIR/$oldest" ] || fail "the oldest real dump was kept"
[ -e "$BACKUP_DIR/$kept_one" ] && [ -e "$BACKUP_DIR/$kept_two" ] || fail "a real dump within the quota was removed"
grep -lq new "$BACKUP_DIR"/*.dump || fail "the dump that was just written was pruned"
for name in $stale; do
  [ -e "$BACKUP_DIR/$name" ] || fail "$name, dated in the future, was removed"
  grep "WARNING" "$STATE/log" | grep -q -F "$name" || fail "the warning does not name $name"
done
[ "$(grep -c "WARNING" "$STATE/log")" -ge 2 ] || fail "the warning is not repeated at the start and after the dump"

begin "a dump with a date that does not exist is left alone and reported"
echo "old" >"$BACKUP_DIR/labeling-20261340T250000Z.dump"
old_dump $((-4 * DAY)) >/dev/null
old_dump $((-3 * DAY)) >/dev/null
old_dump $((-2 * DAY)) >/dev/null
run_loop
expect 1 4
[ -e "$BACKUP_DIR/labeling-20261340T250000Z.dump" ] || fail "the dump with the impossible date was removed"
grep "WARNING" "$STATE/log" | grep -q -F "labeling-20261340T250000Z.dump" || fail "the log does not name it"

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

begin "once, with every other dump dated in the future: all of them stay"
old_dump $((1 * DAY)) >/dev/null
old_dump $((2 * DAY)) >/dev/null
old_dump $((3 * DAY)) >/dev/null
PATH="$work/bin:$PATH" sh "$here/backup.sh" once >"$STATE/log" 2>&1 || fail "once failed"
[ "$(dump_count)" -eq 4 ] || fail "expected 4 dump files, found $(dump_count)"
grep -lq new "$BACKUP_DIR"/*.dump || fail "the dump that was just written was pruned"
grep -q "WARNING" "$STATE/log" || fail "the log does not warn about the dumps dated in the future"
echo "ok: $case_name"

begin "once, with more old dumps than are kept: the oldest go, by the date in the name"
first=$(old_dump $((-5 * DAY)))
second=$(old_dump $((-4 * DAY)))
old_dump $((-3 * DAY)) >/dev/null
old_dump $((-2 * DAY)) >/dev/null
# the oldest by name is the newest by modification time
touch "$BACKUP_DIR/$first"
PATH="$work/bin:$PATH" sh "$here/backup.sh" once >"$STATE/log" 2>&1 || fail "once failed"
[ "$(dump_count)" -eq 3 ] || fail "expected 3 dump files, found $(dump_count)"
[ ! -e "$BACKUP_DIR/$first" ] && [ ! -e "$BACKUP_DIR/$second" ] || fail "the two oldest dumps were not the ones removed"
! grep -q "WARNING" "$STATE/log" || fail "a warning without a dump dated in the future"
echo "ok: $case_name"

# What is in the pretend database $1, or "missing".
database() {
  cat "$STATE/dbs/$1" 2>/dev/null || echo missing
}

# Runs a restore of $1 against the pretend databases. Sets $status.
run_restore() {
  status=0
  PATH="$work/bin:$PATH" PGUSER=labeling sh "$here/backup.sh" restore "$1" >"$STATE/log" 2>&1 || status=$?
}

# After a restore that must not have changed anything.
expect_untouched() {
  [ "$status" -ne 0 ] || fail "the restore reported success"
  [ "$(database labeling)" = "the data in use" ] || fail "the database is no longer what it was: $(database labeling)"
  [ "$(database labeling_restoring)" = missing ] || fail "the copy that was being restored was left behind"
  [ "$(database labeling_replaced)" = missing ] || fail "a database was set aside although nothing was swapped"
  grep -q "labeling was left as it was" "$STATE/log" || fail "it does not say that the database was left as it was"
  ! grep -q "^dropdb .* labeling$" "$STATE/calls" || fail "the database in use was dropped"
}

begin "restore: the copy takes the place of the database, which goes last"
echo "the data in use" >"$STATE/dbs/labeling"
dump=$(old_dump -3600)
run_restore "$dump"
[ "$status" -eq 0 ] || fail "the restore failed (exit $status)"
[ "$(database labeling)" = "restored from $dump" ] || fail "the database holds: $(database labeling)"
[ "$(database labeling_restoring)" = missing ] || fail "the copy is still there under its working name"
[ "$(database labeling_replaced)" = missing ] || fail "the replaced database was not dropped"
! grep -q "^dropdb .* labeling$" "$STATE/calls" || fail "the database in use was dropped instead of renamed"
# both renames in one call, so that the server can take them back together
grep "RENAME TO" "$STATE/calls" | grep -c . | grep -qx 1 || fail "the swap is more than one psql call"
grep "RENAME TO" "$STATE/calls" | grep -q -- "--single-transaction" || fail "the swap is not one transaction"
echo "ok: $case_name"

begin "restore: on a server without the database yet"
dump=$(old_dump -3600)
run_restore "$dump"
[ "$status" -eq 0 ] || fail "the restore failed (exit $status)"
[ "$(database labeling)" = "restored from $dump" ] || fail "the database holds: $(database labeling)"
[ "$(ls "$STATE/dbs" | wc -l)" -eq 1 ] || fail "more than the one database is left"
echo "ok: $case_name"

begin "restore: a damaged dump changes nothing"
echo "the data in use" >"$STATE/dbs/labeling"
dump=$(old_dump -3600)
touch "$STATE/restore-fails"
run_restore "$dump"
expect_untouched
! grep -q "RENAME TO" "$STATE/calls" || fail "a swap was tried with a copy that did not load"
echo "ok: $case_name"

begin "restore: refused while something is connected, and it says what"
echo "the data in use" >"$STATE/dbs/labeling"
dump=$(old_dump -3600)
echo 1 >"$STATE/fail-rename"
printf 'labeling-backup (1)\nlabeling-portal (3)\n' >"$STATE/sessions"
run_restore "$dump"
expect_untouched
grep -q "Still connected to it: labeling-backup (1), labeling-portal (3)" "$STATE/log" || fail "it does not say who is connected"
grep -q "docker compose --profile backup stop app backup" "$STATE/log" || fail "it does not say to stop both services"
echo "ok: $case_name"

begin "restore: the second rename fails, and the first is taken back"
echo "the data in use" >"$STATE/dbs/labeling"
dump=$(old_dump -3600)
echo 2 >"$STATE/fail-rename"
run_restore "$dump"
expect_untouched
grep -q "Nothing is connected to it" "$STATE/log" || fail "it blames a connection that is not there"
echo "ok: $case_name"

begin "restore: an earlier one was stopped right after its swap"
echo "restored earlier" >"$STATE/dbs/labeling"
echo "what that restore replaced" >"$STATE/dbs/labeling_replaced"
echo "half of something" >"$STATE/dbs/labeling_restoring"
dump=$(old_dump -3600)
run_restore "$dump"
[ "$status" -eq 0 ] || fail "the restore failed (exit $status)"
[ "$(database labeling)" = "restored from $dump" ] || fail "the database holds: $(database labeling)"
[ "$(ls "$STATE/dbs" | wc -l)" -eq 1 ] || fail "what the earlier restore left behind is still there"
echo "ok: $case_name"

begin "restore: the leftover is not touched when the dump does not load"
echo "restored earlier" >"$STATE/dbs/labeling"
echo "what that restore replaced" >"$STATE/dbs/labeling_replaced"
dump=$(old_dump -3600)
touch "$STATE/restore-fails"
run_restore "$dump"
[ "$status" -ne 0 ] || fail "the restore reported success"
[ "$(database labeling)" = "restored earlier" ] || fail "the database is no longer what it was"
[ "$(database labeling_replaced)" = "what that restore replaced" ] || fail "the leftover was dropped by a restore that failed"
echo "ok: $case_name"

begin "restore: the replaced database cannot be dropped afterwards"
echo "the data in use" >"$STATE/dbs/labeling"
dump=$(old_dump -3600)
touch "$STATE/drop-fails-labeling_replaced"
run_restore "$dump"
[ "$status" -eq 0 ] || fail "the restore failed although the swap was done (exit $status)"
[ "$(database labeling)" = "restored from $dump" ] || fail "the database holds: $(database labeling)"
[ "$(database labeling_replaced)" = "the data in use" ] || fail "the replaced database is gone"
grep -q "still there as the database labeling_replaced" "$STATE/log" || fail "it does not say where the old data is"
echo "ok: $case_name"

begin "restore: needs no backup folder it can write to"
echo "the data in use" >"$STATE/dbs/labeling"
dump=$(old_dump -3600)
mv "$BACKUP_DIR/$dump" "$work/elsewhere.dump"
BACKUP_DIR="$work/no-such-folder"
run_restore "$work/elsewhere.dump"
BACKUP_DIR="$work/dumps"
[ "$status" -eq 0 ] || fail "the restore failed (exit $status)"
[ "$(database labeling)" = "restored from elsewhere.dump" ] || fail "the database holds: $(database labeling)"
echo "ok: $case_name"

echo "OK: the loop, the pruning and the restore held in every case"
