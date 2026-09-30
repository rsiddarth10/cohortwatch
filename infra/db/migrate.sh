#!/bin/sh
# One-shot migration runner (the db-migrate compose service).
# Applies infra/db/migrations/*.sql in name order, each in its own transaction, exactly once.
set -eu

: "${PGHOST:=postgres}"
: "${PGUSER:=postgres}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${CW_DB:=cohortwatch}"
: "${CW_SIM_PASSWORD:?CW_SIM_PASSWORD is required}"
: "${CW_APP_PASSWORD:?CW_APP_PASSWORD is required}"
: "${CW_API_PASSWORD:=cw_api_dev}"
PGOPTIONS="-c client_min_messages=warning"
export PGHOST PGUSER PGPASSWORD PGOPTIONS
DIR="${MIGRATIONS_DIR:-/migrations}"

# Create the database on first boot.
psql -d postgres -v ON_ERROR_STOP=1 -qtA -v db="$CW_DB" <<'SQL'
SELECT format('CREATE DATABASE %I', :'db') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL

psql -d "$CW_DB" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS public.schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

applied=0
for f in "$DIR"/*.sql; do
  name=$(basename "$f")
  done_already=$(psql -d "$CW_DB" -qtA -v name="$name" <<'SQL'
SELECT 1 FROM public.schema_migrations WHERE filename = :'name'
SQL
)
  if [ -n "$done_already" ]; then
    echo "skip   $name"
    continue
  fi
  echo "apply  $name"
  psql -d "$CW_DB" -v ON_ERROR_STOP=1 -q --single-transaction \
    -v cw_sim_password="$CW_SIM_PASSWORD" -v cw_app_password="$CW_APP_PASSWORD" -v cw_api_password="$CW_API_PASSWORD" -v name="$name" \
    -f "$f" \
    -c "INSERT INTO public.schema_migrations (filename) VALUES ('$name')"
  applied=$((applied + 1))
done
echo "migrations done ($applied applied)"
