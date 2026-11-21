#!/bin/sh
# Database backups for labeling-portal. Runs in the postgres image, which
# already has pg_dump and pg_restore, and connects with the usual PG*
# variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE).
#
#   backup.sh                  dump once a day until stopped (the compose service)
#   backup.sh once             dump now and exit
#   backup.sh restore <file>   replace the database with a dump
#
# Dumps go to $BACKUP_DIR as labeling-<UTC time>.dump in pg_dump's custom
# format. After every dump only the newest $BACKUP_KEEP are kept.
#
# The time in the name is the only time that counts, for the age of a dump
# and for the order they are pruned in. Modification times are not looked
# at: on a network share they come from another machine's clock.
#
# After every dump attempt a row goes into the app's "BackupRun" table, so
# that the app can tell an admin when the last dump failed or is late. A
# database without that table (an app older than it, or a stack that is
# still migrating) gets no row and a line in the log, and the dump is not
# affected. BACKUP_STATUS=off writes no rows.
#
# A dump whose name is dated in the future was made while the clock was
# wrong. Such dumps, and dumps whose name holds a date that does not exist,
# are never removed here and do not use up BACKUP_KEEP, and every run names
# them in a warning.
set -eu

dir=${BACKUP_DIR:-/backups}
keep=${BACKUP_KEEP:-7}
interval=${BACKUP_INTERVAL_SECONDS:-86400}
status=${BACKUP_STATUS:-on}
# where psql's complaint about a row it could not write is kept for the log
work_file=${TMPDIR:-/tmp}/backup-record.$$

# A dump holds accounts, password hashes, answers and pay data: owner only.
umask 077

# The dump being written, if any, so that it can be removed when stopped.
partial=''

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

fail() {
  log "$*" >&2
  exit 1
}

is_positive_integer() {
  case $1 in
    '' | 0* | *[!0-9]*) return 1 ;;
  esac
}

check_database() {
  [ -n "${PGDATABASE:-}" ] || fail "PGDATABASE is not set"
}

# What making a dump needs. A restore only reads a dump, so it does not ask
# for a folder it can write to.
check_settings() {
  is_positive_integer "$keep" || fail "BACKUP_KEEP must be a whole number above zero, got '$keep'"
  is_positive_integer "$interval" || fail "BACKUP_INTERVAL_SECONDS must be a whole number above zero, got '$interval'"
  check_database
  if [ ! -d "$dir" ] || [ ! -w "$dir" ]; then
    fail "cannot write to $dir"
  fi
}

# File names of the finished dumps, newest first, going by the time in the
# name.
dumps() {
  ls -1 "$dir" | grep -E '^labeling-[0-9]{8}T[0-9]{6}Z\.dump$' | sort -r
}

# The time in a dump's name as seconds since 1970. Prints nothing when the
# name does not hold a real date. Busybox date, which the postgres image has,
# rolls an impossible date over instead of refusing it (2026-02-31 becomes
# 3 March), so the time is written back as a name and has to give the same
# name. Otherwise such a dump would pass for one made on 3 March and could be
# pruned.
dump_time() {
  stamp=${1#labeling-}
  stamp=${stamp%.dump}
  made=$(date -u -d "$(echo "$stamp" | sed -E 's/^(....)(..)(..)T(..)(..)(..)Z$/\1-\2-\3 \4:\5:\6/')" +%s 2>/dev/null) || return 0
  [ "$(date -u -d "@$made" +%Y%m%dT%H%M%SZ 2>/dev/null)" = "$stamp" ] || return 0
  echo "$made"
}

# The dumps dated at or before a clock that reads $1, newest first. These
# are the ones that say how old the newest dump is, and the ones that are
# pruned.
present_dumps() {
  dumps | while read -r candidate; do
    made=$(dump_time "$candidate")
    if [ -n "$made" ] && [ "$made" -le "$1" ]; then
      echo "$candidate"
    fi
  done
}

# The rest: dated after $1, or with a date that does not exist. Sorted by
# name they would pass for the newest dumps for as long as their date lies
# ahead, and pruning would delete a real dump for each of them.
future_dumps() {
  dumps | while read -r candidate; do
    made=$(dump_time "$candidate")
    if [ -z "$made" ] || [ "$made" -gt "$1" ]; then
      echo "$candidate"
    fi
  done
}

# Nothing removes these by itself, so a person has to hear about them.
warn_about_future_dumps() {
  ahead=$(future_dumps "$1" | tr '\n' ' ')
  [ -z "$ahead" ] || log "WARNING: dated in the future or on a date that does not exist, so never removed here and not counted towards BACKUP_KEEP. Have a look at: $ahead"
}

# Removes the oldest dumps until $keep are left. Only dumps that are not
# dated in the future count and can go. The dump that was just written ($1)
# is never removed.
prune() {
  clock=$(date +%s)
  present_dumps "$clock" | grep -v -x -F "$1" | tail -n +"$keep" | while read -r old; do
    rm -f "$dir/$old"
    log "removed $old"
  done
  warn_about_future_dumps "$clock"
}

# How many rows "BackupRun" keeps. A database that is down gets an attempt
# a minute, so without a limit a long outage would add 1,440 rows a day.
runs_keep=500

# Writes the row of one attempt to "BackupRun" and removes all but the newest
# $runs_keep rows:
#   record <started> <ok: true or false> <file> <bytes> <message>
# Empty values are stored as nothing. The values go in as psql variables, so
# a message with quotes in it cannot break the statement. The row is written
# after the dump, so it is in the next dump and not in its own.
record() {
  [ "$status" != off ] || return 0
  if ! psql -qAtX -v ON_ERROR_STOP=1 \
    -v started="$1" -v finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)" -v ok="$2" \
    -v file="$3" -v bytes="$4" -v message="$5" -v interval="$interval" \
    -v keep="$runs_keep" >/dev/null 2>"$work_file" <<'SQL'
insert into "BackupRun" ("startedAt", "finishedAt", ok, file, bytes, message, "intervalSeconds")
values (:'started', :'finished', :'ok'::boolean, nullif(:'file', ''),
        nullif(:'bytes', '')::bigint, nullif(:'message', ''), :'interval'::integer);
delete from "BackupRun"
where id not in (select id from "BackupRun" order by id desc limit :'keep'::integer);
SQL
  then
    missing=$(psql -AtXq -c "select to_regclass('public.\"BackupRun\"') is null" 2>/dev/null) || missing=''
    if [ "$missing" = t ]; then
      log "the database has no BackupRun table yet (an older app, or its migrations have not run), so this attempt is not recorded"
    else
      log "could not record this attempt in BackupRun: $(head -n 1 "$work_file")"
    fi
  fi
  rm -f "$work_file"
}

# What a failed pg_dump said, for its row: the first "pg_dump: error:" line,
# or the first line when there is none, in printable ASCII only and at most
# 500 characters, so that cutting it cannot split a character in two.
dump_error() {
  line=$(grep -m 1 '^pg_dump: error:' "$1" || true)
  [ -n "$line" ] || line=$(grep -m 1 . "$1" || true)
  printf '%s' "$line" | tr -cd ' -~' | cut -c 1-500
}

# pg_dump writes to a hidden .partial file that is renamed when it is
# complete, so a dump that was cut short never counts as a backup. Every
# step is checked by hand because "set -e" is off inside "if dump".
dump() {
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  name="labeling-$(date -u +%Y%m%dT%H%M%SZ).dump"
  partial="$dir/.$name.partial"
  # What pg_dump says goes to the log as before, and its last line into the
  # row of a dump that failed.
  errors=$(mktemp)
  if ! pg_dump --format=custom --file="$partial" 2>"$errors"; then
    cat "$errors" >&2
    rm -f "$partial"
    partial=''
    record "$started" false '' '' "$(dump_error "$errors")"
    rm -f "$errors"
    return 1
  fi
  cat "$errors" >&2
  rm -f "$errors"
  # Docker runs this as root. Give the dump to whoever owns the folder, so
  # that on the host it belongs to the same user as the folder it is in.
  if [ "$(id -u)" = 0 ]; then
    chown "$(stat -c %u:%g "$dir")" "$partial" 2>/dev/null || true
  fi
  if ! mv "$partial" "$dir/$name"; then
    rm -f "$partial"
    partial=''
    record "$started" false '' '' "could not rename the finished dump to $name"
    return 1
  fi
  partial=''
  bytes=$(wc -c <"$dir/$name" | tr -d ' ')
  log "wrote $name ($bytes bytes)"
  record "$started" true "$name" "$bytes" ''
  prune "$name"
}

# When the newest dump was made, as seconds since 1970, for a clock that
# reads $1. Dumps dated after that are skipped: the clock was wrong when they
# were made, so they say nothing about the age of the newest real one.
# Prints nothing when no dump is left to go by.
newest_dump_time() {
  present_dumps "$1" | while read -r candidate; do
    dump_time "$candidate"
    break
  done
}

# Sleeps in the background so that "docker compose stop" is not kept waiting.
nap() {
  sleep "$1" &
  wait $!
}

# The daily loop. What it has to get right, because getting it wrong deletes
# backups: a dump followed at once by another dump prunes one old dump per
# round until the history is gone.
#
#   - "last" is when the newest dump was made. It is read from the file names
#     once, at the start. After that it is only ever set to the current time,
#     so nothing on disk and no change of the clock can make a dump look
#     overdue twice in a row.
#   - Dumps dated in the future are left out when the age of the newest dump
#     is worked out. If nothing else is there, the loop waits a full interval
#     before its first dump instead of dumping at once.
#   - After every attempt, whether it worked or not, there is a pause before
#     the next one.
#   - The wait is slept in steps of at most a minute, with a look at the clock
#     after each. One long sleep would not count the time a laptop spends
#     suspended, and the dumps would come less often than daily.
run() {
  check_settings
  trap 'rm -f "$partial"; log "stopping"; exit 0' TERM INT
  step=$((interval < 60 ? interval : 60))
  # Left behind if the last run was killed in the middle of a dump.
  rm -f "$dir"/.labeling-*.partial
  log "dumping $PGDATABASE to $dir every ${interval}s, keeping the newest $keep"

  now=$(date +%s)
  warn_about_future_dumps "$now"
  last=$(newest_dump_time "$now")
  if [ -z "$last" ] && [ -n "$(dumps | head -n 1)" ]; then
    log "every dump in $dir is dated in the future, waiting a full interval before the first dump"
    last=$now
  fi

  while true; do
    now=$(date +%s)
    if [ -n "$last" ]; then
      # The clock was set back since the last dump.
      [ "$last" -le "$now" ] || last=$now
      left=$((interval - (now - last)))
      if [ "$left" -gt 0 ]; then
        nap "$((left < step ? left : step))"
        continue
      fi
    fi
    # On a new stack this starts before the app has applied the migrations.
    tables=$(psql -AtXq -c "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')" 2>/dev/null) || tables=unknown
    if [ "$tables" = 0 ]; then
      log "$PGDATABASE has no tables yet, looking again in ${step}s"
    elif dump; then
      last=$now
    else
      log "dump failed, trying again in ${step}s"
    fi
    nap "$step"
  done
}

# dropdb without the notice it prints when there is nothing to drop.
drop() {
  PGOPTIONS='-c client_min_messages=warning' dropdb --if-exists "$1"
}

database_exists() {
  [ -n "$(psql -AtXq -d postgres -c "select 1 from pg_database where datname = '$1'" 2>/dev/null)" ]
}

# Who is connected to database $1, as "name (sessions)", for the message of a
# restore that was refused.
connected_to() {
  psql -AtXq -d postgres -c "select coalesce(nullif(application_name, ''), 'a client without a name') || ' (' || count(*) || ')' from pg_stat_activity where datname = '$1' and pid <> pg_backend_pid() group by application_name order by application_name" 2>/dev/null |
    tr '\n' ',' | sed -e 's/,$//' -e 's/,/, /g'
}

# Replaces the database with a dump, in three steps:
#
#   1. The dump is loaded into a new database, <name>_restoring. A damaged
#      dump stops here and the current data was never touched.
#   2. The swap, in one transaction: the current database is renamed to
#      <name>_replaced and the restored copy takes its name. Either both
#      renames happen or neither does, so there is no moment without a
#      database under the name. That matters because the app creates a
#      missing database when it starts (prisma migrate deploy): an empty one,
#      which the daily loop would then dump while the real data sat under
#      another name. PostgreSQL refuses the rename while anything is
#      connected, which is what keeps a running app from being cut off.
#   3. Only after the swap has committed is <name>_replaced dropped.
#
# Killed at any point, this leaves a complete database under the name: the
# old one before the swap, the restored one after it. What stays behind is a
# _restoring or _replaced database, and the next restore removes it.
restore() {
  check_database
  file=${1:-}
  if [ -z "$file" ]; then
    echo "usage: restore <file>" >&2
    echo "dumps in $dir, newest first:" >&2
    dumps >&2
    exit 1
  fi
  [ -f "$file" ] || file="$dir/$file"
  [ -f "$file" ] || fail "no such dump: $1"

  incoming="${PGDATABASE}_restoring"
  replaced="${PGDATABASE}_replaced"

  drop "$incoming" || fail "could not remove $incoming, which an earlier restore left behind. $PGDATABASE was left as it was."
  createdb "$incoming" || fail "could not create $incoming. $PGDATABASE was left as it was."
  if ! pg_restore --exit-on-error --no-owner --dbname="$incoming" "$file"; then
    drop "$incoming" || true
    fail "could not restore $(basename "$file"), $PGDATABASE was left as it was"
  fi

  swapped=0
  if database_exists "$PGDATABASE"; then
    # What a restore that was stopped right after its swap left behind: the
    # data it had replaced. With $PGDATABASE there it is never the only copy.
    if ! drop "$replaced"; then
      drop "$incoming" || true
      fail "could not remove $replaced, which an earlier restore left behind. $PGDATABASE was left as it was."
    fi
    psql -qX -v ON_ERROR_STOP=1 --single-transaction -d postgres \
      -c "ALTER DATABASE \"$PGDATABASE\" RENAME TO \"$replaced\"" \
      -c "ALTER DATABASE \"$incoming\" RENAME TO \"$PGDATABASE\"" || swapped=$?
  else
    # A new server: nothing to set aside, and one rename is one transaction.
    psql -qX -v ON_ERROR_STOP=1 -d postgres \
      -c "ALTER DATABASE \"$incoming\" RENAME TO \"$PGDATABASE\"" || swapped=$?
  fi
  if [ "$swapped" -ne 0 ]; then
    # The transaction was rolled back, so nothing was renamed.
    who=$(connected_to "$PGDATABASE")
    drop "$incoming" || true
    log "could not put the restored copy in the place of $PGDATABASE. $PGDATABASE was left as it was." >&2
    if [ -n "$who" ]; then
      log "Still connected to it: $who." >&2
      log "Stop what is connected and run the restore again. With the compose stack that is:" >&2
      log "  docker compose --profile backup stop app backup" >&2
    else
      log "Nothing is connected to it, so the reason is in the error above." >&2
    fi
    exit 1
  fi
  log "restored $PGDATABASE from $(basename "$file")"

  if ! drop "$replaced"; then
    log "The data it replaced is still there as the database $replaced. Remove it with: dropdb $replaced" >&2
  fi
}

case ${1:-run} in
  run)
    run
    ;;
  once)
    check_settings
    dump || fail "dump failed"
    ;;
  restore)
    shift
    restore "$@"
    ;;
  *)
    echo "usage: backup.sh [run | once | restore <file>]" >&2
    exit 1
    ;;
esac
