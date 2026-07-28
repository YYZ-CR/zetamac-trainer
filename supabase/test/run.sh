#!/usr/bin/env bash
#
# Rebuild a throwaway database from the migration files and run the contract
# tests in 02-test.sql.
#
#   supabase/test/run.sh
#
# Needs a local PostgreSQL 14+ server. Nothing here touches your Supabase
# project — it builds a local database named `zt_test` from scratch every run.
#
# Connection is taken from the standard libpq environment variables, so any of
# these work:
#
#   PGHOST=localhost PGPORT=5432 PGUSER=postgres supabase/test/run.sh
#   PGHOST=/var/run/postgresql PGPORT=5433 supabase/test/run.sh
#
# On a machine where the server runs as the `postgres` system user and the
# invoking user is root, set ZT_SU=1 to run psql through `su postgres`.
#
# Every step fails loudly. An unreadable file or a failed DROP DATABASE must
# not pass silently — that produces a green run against a stale database, which
# proves nothing.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DB="${ZT_TEST_DB:-zt_test}"

PSQL_ARGS="-v ON_ERROR_STOP=1 -q"

# When running psql as another system user, the SQL files must live somewhere
# that user can actually read — a home directory or a private temp dir will
# fail with "Permission denied" partway through and leave a half-built schema.
if [ "${ZT_SU:-0}" = "1" ]; then
  STAGE=/tmp/zt-test-stage
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  cp "$HERE"/*.sql "$REPO"/supabase/*.sql "$STAGE"/
  chmod -R a+rX "$STAGE"
  SQLDIR_TEST="$STAGE"
  SQLDIR_MIG="$STAGE"
  # `su` does not carry the caller's environment, so libpq's connection
  # variables have to be re-exported inside the shell it starts.
  PGENV="PGHOST='${PGHOST:-/var/run/postgresql}' PGPORT='${PGPORT:-5432}'"
  psql_run() { su postgres -c "$PGENV psql $PSQL_ARGS $*"; }
else
  SQLDIR_TEST="$HERE"
  SQLDIR_MIG="$REPO/supabase"
  psql_run() { eval "psql $PSQL_ARGS $*"; }
fi

run_sql() {
  local f="$1"
  [ -r "$f" ] || { echo "UNREADABLE: $f" >&2; exit 1; }
  local out
  out="$(psql_run "-d $DB -f '$f'" 2>&1)" || { echo "$out"; echo "SQL FAILED: $f" >&2; exit 1; }
  echo "$out" | grep -vE '^\s*$' || true
  if echo "$out" | grep -q '^psql.*ERROR'; then
    echo "SQL ERROR in $f" >&2; exit 1
  fi
}

echo "=== resetting $DB ==="
psql_run "-d postgres -c 'DROP DATABASE IF EXISTS $DB;'"
psql_run "-d postgres -c 'CREATE DATABASE $DB;'"

echo "=== applying migrations ==="
run_sql "$SQLDIR_TEST/00-shim.sql"        # stands in for Supabase's auth schema
run_sql "$SQLDIR_MIG/schema.sql"
run_sql "$SQLDIR_MIG/hardening.sql"
run_sql "$SQLDIR_MIG/social.sql"
[ -r "$SQLDIR_MIG/daily.sql" ] && run_sql "$SQLDIR_MIG/daily.sql"
[ -r "$SQLDIR_MIG/duels.sql" ] && run_sql "$SQLDIR_MIG/duels.sql"
[ -r "$SQLDIR_MIG/leagues.sql" ] && run_sql "$SQLDIR_MIG/leagues.sql"

# These files are applied by hand in the Supabase SQL editor, so somebody will
# eventually paste one twice. Re-applying here proves that is harmless.
echo "=== re-applying migrations (idempotency) ==="
run_sql "$SQLDIR_MIG/social.sql"
[ -r "$SQLDIR_MIG/daily.sql" ] && run_sql "$SQLDIR_MIG/daily.sql"
[ -r "$SQLDIR_MIG/duels.sql" ] && run_sql "$SQLDIR_MIG/duels.sql"
[ -r "$SQLDIR_MIG/leagues.sql" ] && run_sql "$SQLDIR_MIG/leagues.sql"

echo "=== seeding ==="
run_sql "$SQLDIR_TEST/01-seed.sql"

# Both suites run in ONE psql invocation. The pg_temp.ok/as_user helpers are
# defined in 02-test.sql and pg_temp is session-scoped, so a second invocation
# would not see them.
echo "=== contract tests ==="
TESTS="-f '$SQLDIR_TEST/02-test.sql'"
[ -r "$SQLDIR_MIG/daily.sql" ] && TESTS="$TESTS -f '$SQLDIR_TEST/03-daily-test.sql'"
[ -r "$SQLDIR_MIG/duels.sql" ] && TESTS="$TESTS -f '$SQLDIR_TEST/04-duels-test.sql'"
[ -r "$SQLDIR_MIG/leagues.sql" ] && TESTS="$TESTS -f '$SQLDIR_TEST/05-leagues-test.sql'"
psql_run "-d $DB $TESTS" 2>&1 | sed 's/^psql.*NOTICE:  //'
