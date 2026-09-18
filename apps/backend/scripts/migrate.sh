#!/bin/sh
# Applies pending SQL files from supabase/migrations against $DATABASE_URL,
# in filename order, tracking what's already applied in a _migrations table
# so this is safe to run on every deploy (Railway preDeployCommand).
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "migrate.sh: DATABASE_URL is not set, skipping migrations." >&2
  exit 0
fi

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/repo/supabase/migrations}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS _migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"

for f in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$f")"
  already=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc \
    "SELECT 1 FROM _migrations WHERE filename = '$name';")
  if [ "$already" = "1" ]; then
    echo "migrate.sh: skipping already-applied $name"
    continue
  fi
  echo "migrate.sh: applying $name"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f" \
    -c "INSERT INTO _migrations (filename) VALUES ('$name');"
done

echo "migrate.sh: done."
