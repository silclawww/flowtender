#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
database_url="${FLOWTENDER_TEST_DATABASE_URL:-}"

if ! command -v psql >/dev/null 2>&1; then
  echo "migration DB test requires psql" >&2
  exit 2
fi

if [[ -z "$database_url" ]]; then
  echo "set FLOWTENDER_TEST_DATABASE_URL to a disposable local PostgreSQL/Supabase database" >&2
  exit 2
fi

case "$database_url" in
  postgres://*@localhost:*/*|postgresql://*@localhost:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@127.0.0.1:*/*)
    ;;
  *)
    echo "refusing non-local database URL" >&2
    exit 2
    ;;
esac

if [[ "${FLOWTENDER_TEST_DATABASE_DISPOSABLE:-}" != "YES" ]]; then
  echo "set FLOWTENDER_TEST_DATABASE_DISPOSABLE=YES to confirm the local database may be reset" >&2
  exit 2
fi

psql_args=("$database_url" --no-psqlrc --set ON_ERROR_STOP=1)

psql "${psql_args[@]}" \
  --file "$repo_dir/tests/sql/migration-db-setup.sql" \
  --file "$repo_dir/supabase/migrations/001_flowtender_schema.sql" \
  --file "$repo_dir/tests/sql/migration-db-seed-legacy.sql" \
  --file "$repo_dir/supabase/migrations/002_secure_redacted_telemetry.sql" \
  --file "$repo_dir/supabase/migrations/002_secure_redacted_telemetry.sql" \
  --file "$repo_dir/supabase/migrations/003_pipeline_admission.sql" \
  --file "$repo_dir/supabase/migrations/003_pipeline_admission.sql" \
  --file "$repo_dir/tests/sql/migration-db-simulate-001-drift.sql" \
  --file "$repo_dir/supabase/migrations/004_repair_flowtender_schema.sql" \
  --file "$repo_dir/supabase/migrations/004_repair_flowtender_schema.sql" \
  --file "$repo_dir/tests/sql/migration-db-assertions.sql"

FLOWTENDER_TEST_DATABASE_URL="$database_url" \
FLOWTENDER_TEST_DATABASE_DISPOSABLE=YES \
  "$repo_dir/scripts/test-admission-concurrency.sh"

echo "migration DB test passed"
