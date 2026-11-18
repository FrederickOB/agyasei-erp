#!/usr/bin/env bash
#
# RELEASE-PATH SMOKE TEST against a real Postgres 16 — what CI runs, and what
# anyone can run locally before touching production:
#
#   pnpm --filter @erp/api build && infra/scripts/release-smoke.sh
#
# PGlite (the unit-test database) is a superuser and cannot reproduce the role
# model a managed provider imposes. So this starts a throwaway Postgres 16
# container and stands in a NON-SUPERUSER migrator with CREATEROLE, CREATEDB,
# REPLICATION and BYPASSRLS — the shape of Supabase's `postgres` role — and
# then runs the production bundles exactly as Fly will:
#
#   1. migrate.js on an empty database (the release_command);
#   2. infra/supabase/roles.sql, twice (it must be idempotent);
#   3. migrate.js again (grants converge onto the roles that now exist);
#   4. ops.js verify with every credential — must report no FAIL;
#   5. main.js — /healthz and /readyz must answer 200;
#   6. jobs.js run <every job> — none may fail.
#
# It never touches the shared dev stack: its own container, its own port,
# removed on exit. Passwords here are throwaway and exist only inside it.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/apps/api/dist/bin"
PG_PORT="${SMOKE_PG_PORT:-55499}"
NAME="erp-release-smoke-$$"
IMAGE="${SMOKE_PG_IMAGE:-postgres:16-alpine}"
API_PORT="${SMOKE_API_PORT:-38199}"
API_PID=""
API_LOG="$(mktemp -t erp-release-smoke-api.XXXXXX)"

[ -f "$DIST/migrate.js" ] || { echo "build first: pnpm --filter @erp/api build" >&2; exit 2; }

cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  rm -f "$API_LOG"
  if [ "${SMOKE_KEEP:-0}" = "1" ]; then
    echo "SMOKE_KEEP=1: container $NAME left running on :$PG_PORT (docker rm -f $NAME)" >&2
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }

step "starting $IMAGE as $NAME on :$PG_PORT"
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=smoke -p "127.0.0.1:$PG_PORT:5432" "$IMAGE" \
  -c wal_level=logical -c max_replication_slots=10 -c shared_preload_libraries=pg_stat_statements >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
sleep 1

psql_super() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql_mig() { docker exec -i -e PGPASSWORD=smoke "$NAME" psql -h 127.0.0.1 -U supa_postgres -d erp -v ON_ERROR_STOP=1 -q "$@"; }

psql_super -c "create role supa_postgres login password 'smoke' createrole createdb replication bypassrls" \
           -c "create database erp owner supa_postgres"
psql_super -d erp -c "create extension pg_stat_statements" -c "grant pg_read_all_stats to supa_postgres"

MIG="postgresql://supa_postgres:smoke@127.0.0.1:$PG_PORT/erp"
export DATABASE_SSL_MODE=disable

step "1. release_command on an empty database"
MIGRATE_DATABASE_URL="$MIG" ERP_BUILD=smoke node "$DIST/migrate.js"

step "2. roles.sql, twice"
psql_mig < "$ROOT/infra/supabase/roles.sql"
psql_mig < "$ROOT/infra/supabase/roles.sql"
psql_mig -c "alter role erp_api password 'api-smoke'" \
         -c "alter role erp_jobs password 'jobs-smoke'" \
         -c "alter role powersync_repl password 'repl-smoke'" \
         -c "alter role powersync_storage password 'stor-smoke'" \
         -c "create database powersync_storage" \
         -c "grant connect, create on database powersync_storage to powersync_storage"

step "3. release_command again: grants converge"
MIGRATE_DATABASE_URL="$MIG" ERP_BUILD=smoke node "$DIST/migrate.js"

step "4. provisioning verification (no FAIL allowed)"
MIGRATE_DATABASE_URL="$MIG" \
API_DATABASE_URL="postgresql://erp_api:api-smoke@127.0.0.1:$PG_PORT/erp" \
JOBS_DATABASE_URL="postgresql://erp_jobs:jobs-smoke@127.0.0.1:$PG_PORT/erp" \
POWERSYNC_REPLICATION_URL="postgresql://powersync_repl:repl-smoke@127.0.0.1:$PG_PORT/erp" \
POWERSYNC_STORAGE_URL="postgresql://powersync_storage:stor-smoke@127.0.0.1:$PG_PORT/powersync_storage" \
  node "$DIST/ops.js" verify

step "5. the API serves and is ready"
NODE_ENV=development PORT="$API_PORT" HOST=127.0.0.1 \
DATABASE_URL="postgresql://erp_api:api-smoke@127.0.0.1:$PG_PORT/erp" \
AUTH_JWT_SECRET="smoke-auth-secret-0123456789abcdefghijkl" \
POWERSYNC_JWT_SECRET="smoke-sync-secret-0123456789abcdefghijkl" \
POWERSYNC_URL="http://127.0.0.1:8080" CORS_ORIGINS="http://localhost:5173" \
  node "$DIST/main.js" > "$API_LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$API_PORT/healthz"; echo
if ! curl -fsS "http://127.0.0.1:$API_PORT/readyz"; then
  echo; echo "readyz failed; API log:" >&2; tail -20 "$API_LOG" >&2; exit 1
fi
echo

step "6. every scheduled job runs"
JOBS_DATABASE_URL="postgresql://erp_jobs:jobs-smoke@127.0.0.1:$PG_PORT/erp" \
  node "$DIST/jobs.js" run ledger.posting_sweep credit.sync_scope_refresh ops.table_digest \
    ops.table_digest_full ops.lost_write_control ops.sync_health 2>/dev/null

step "release path OK"
