#!/usr/bin/env bash
set -euo pipefail

database_url="${FLOWTENDER_TEST_DATABASE_URL:-}"

if [[ -z "$database_url" || "${FLOWTENDER_TEST_DATABASE_DISPOSABLE:-}" != "YES" ]]; then
  echo "concurrency test requires a confirmed disposable local database" >&2
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

psql_args=("$database_url" --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align)
retry_root="eeeeeeee-0000-4000-8000-000000000001"
actor_one="aaaaaaaa-0000-4000-8000-000000000001"
org_one="bbbbbbbb-0000-4000-8000-000000000001"
actor_two="aaaaaaaa-0000-4000-8000-000000000003"
org_two="bbbbbbbb-0000-4000-8000-000000000002"

psql "${psql_args[@]}" --command "
  DELETE FROM public.pipeline_admissions;
  INSERT INTO public.pipeline_admissions (
    actor_user_id, org_id, operation, root_execution_id,
    admitted_at, lease_expires_at, claimed_at, released_at
  ) VALUES
    ('$actor_one', '$org_one', 'stage2', '$retry_root',
     clock_timestamp(), clock_timestamp() + interval '12 minutes',
     clock_timestamp(), clock_timestamp()),
    ('$actor_two', '$org_two', 'stage3', '$retry_root',
     clock_timestamp(), clock_timestamp() + interval '12 minutes',
     clock_timestamp(), clock_timestamp());
" >/dev/null

mismatch_reason="$(psql "${psql_args[@]}" --command "
  SELECT reason
  FROM public.acquire_pipeline_admission(
    'aaaaaaaa-0000-4000-8000-000000000002',
    '$org_one',
    'retry',
    '$retry_root'
  );
")"
if [[ "$mismatch_reason" != "retry_context_mismatch" ]]; then
  echo "retry_context_mismatch was not enforced" >&2
  exit 1
fi

results_dir="$(mktemp -d "${TMPDIR:-/tmp}/flowtender-admission.XXXXXX")"
cleanup() {
  rm -rf -- "$results_dir"
}
trap cleanup EXIT

pids=()
for session_index in 1 2 3 4; do
  if (( session_index % 2 == 1 )); then
    actor_id="$actor_one"
    org_id="$org_one"
  else
    actor_id="$actor_two"
    org_id="$org_two"
  fi

  (
    psql "${psql_args[@]}" --command "
      WITH acquired AS MATERIALIZED (
        SELECT * FROM public.acquire_pipeline_admission(
          '$actor_id', '$org_id', 'retry', '$retry_root'
        )
      ), released AS MATERIALIZED (
        SELECT public.release_pipeline_admission(lease_id)
        FROM acquired
        WHERE allowed
      )
      SELECT CASE WHEN acquired.allowed THEN 'allowed' ELSE acquired.reason END
      FROM acquired
      LEFT JOIN released ON true;
    "
  ) >"$results_dir/$session_index" &
  pids+=("$!")
done

for process_id in "${pids[@]}"; do
  wait "$process_id"
done

allowed_count="$(grep -h -x -c 'allowed' "$results_dir"/* | awk '{ total += $1 } END { print total + 0 }')"
ceiling_count="$(grep -h -x -c 'retry_ceiling' "$results_dir"/* | awk '{ total += $1 } END { print total + 0 }')"
stored_count="$(psql "${psql_args[@]}" --command "
  SELECT count(*)
  FROM public.pipeline_admissions
  WHERE operation = 'retry' AND root_execution_id = '$retry_root';
")"

if [[ "$allowed_count" != "2" || "$ceiling_count" != "2" || "$stored_count" != "2" ]]; then
  echo "retry race escaped the global root ceiling" >&2
  exit 1
fi

echo "admission concurrency test passed"
