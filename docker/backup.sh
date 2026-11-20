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
# A dump whose name is dated in the future was made while the clock was
# wrong. Such dumps are never removed here and do not use up BACKUP_KEEP, and
# every run names them in a warning.
set -eu

dir=${BACKUP_DIR:-/backups}
keep=${BACKUP_KEEP:-7}
interval=${BACKUP_INTERVAL_SECONDS:-86400}

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

check_settings() {
  is_positive_integer "$keep" || fail "BACKUP_KEEP must be a whole number above zero, got '$keep'"
  is_positive_integer "$interval" || fail "BACKUP_INTERVAL_SECONDS must be a whole number above zero, got '$interval'"
  [ -n "${PGDATABASE:-}" ] || fail "PGDATABASE is not set"
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
# name does not hold a real date.
dump_time() {
  date -u -d "$(echo "$1" | sed -E 's/^labeling-(....)(..)(..)T(..)(..)(..)Z\.dump$/\1-\2-\3 \4:\5:\6/')" +%s 2>/dev/null || true
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
  [ -z "$ahead" ] || log "WARNING: dated in the future, so never removed here and not counted towards BACKUP_KEEP. Have a look at: $ahead"
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

# pg_dump writes to a hidden .partial file that is renamed when it is
# complete, so a dump that was cut short never counts as a backup. Every
# step is checked by hand because "set -e" is off inside "if dump".
dump() {
  name="labeling-$(date -u +%Y%m%dT%H%M%SZ).dump"
  partial="$dir/.$name.partial"
  if ! pg_dump --format=custom --file="$partial"; then
    rm -f "$partial"
    partial=''
    return 1
  fi
  # Docker runs this as root. Give the dump to whoever owns the folder, so
  # that on the host it belongs to the same user as the folder it is in.
  if [ "$(id -u)" = 0 ]; then
    chown "$(stat -c %u:%g "$dir")" "$partial" 2>/dev/null || true
  fi
  if ! mv "$partial" "$dir/$name"; then
    rm -f "$partial"
    partial=''
    return 1
  fi
  partial=''
  log "wrote $name ($(wc -c <"$dir/$name") bytes)"
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

# Restores into a new database first and swaps it in only when that worked,
# so a damaged dump cannot take the current data with it.
restore() {
  check_settings
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
  drop "$incoming"
  createdb "$incoming"
  if ! pg_restore --exit-on-error --no-owner --dbname="$incoming" "$file"; then
    drop "$incoming"
    fail "could not restore $(basename "$file"), $PGDATABASE was left as it was"
  fi
  if ! drop "$PGDATABASE"; then
    drop "$incoming"
    fail "could not replace $PGDATABASE, something is still connected to it. It was left as it was. Stop the app and try again."
  fi
  rename="ALTER DATABASE \"$incoming\" RENAME TO \"$PGDATABASE\""
  if ! psql -qX -v ON_ERROR_STOP=1 -d postgres -c "$rename"; then
    # The old database is gone and the copy does not have its name yet.
    log "$PGDATABASE was dropped, but the restored copy could not be given its name." >&2
    log "Nothing is lost: the data from $(basename "$file") is in the database $incoming." >&2
    # prisma migrate deploy creates a database that is missing, and then the
    # name would be taken.
    log "Leave the app stopped until this is done: on start it would create a new, empty $PGDATABASE." >&2
    log "To finish the restore, run this against the same server:" >&2
    log "  psql ${PGUSER:+-U $PGUSER }-d postgres -c '$rename'" >&2
    log "With the compose stack that is:" >&2
    log "  docker compose exec db psql ${PGUSER:+-U $PGUSER }-d postgres -c '$rename'" >&2
    exit 1
  fi
  log "restored $PGDATABASE from $(basename "$file")"
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
