#!/bin/sh
set -e

# Without SESSION_SECRET, a random one is made on the first start and kept
# in $SECRET_DIR (a volume in the compose file), so the quick start works
# and nobody runs on a value that is published in the repository. The file
# is made under another name and linked into place, so when the app and the
# worker start at once only the first link wins, and both read back the
# file that is in place.
if [ -z "${SESSION_SECRET:-}" ]; then
  dir=${SECRET_DIR:-/app/data}
  file="$dir/session-secret"
  if [ ! -s "$file" ]; then
    umask 077
    tmp=$(mktemp "$dir/.session-secret.XXXXXX")
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$tmp"
    # a link fails when the file is there already, so a secret is never replaced
    if ln "$tmp" "$file" 2>/dev/null; then
      echo "made a new SESSION_SECRET in $file"
    fi
    rm -f "$tmp"
  fi
  SESSION_SECRET=$(cat "$file")
  export SESSION_SECRET
fi

echo "applying database migrations"
node_modules/.bin/prisma migrate deploy

if [ "${SEED_DEMO:-false}" = "true" ]; then
  node_modules/.bin/tsx prisma/seed.ts
fi

exec "$@"
