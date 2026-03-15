#!/bin/sh
set -e

echo "applying database migrations"
node_modules/.bin/prisma migrate deploy

if [ "${SEED_DEMO:-false}" = "true" ]; then
  node_modules/.bin/tsx prisma/seed.ts
fi

exec "$@"
