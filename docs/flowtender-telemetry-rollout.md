# Flowtender telemetry maintenance rollout

This is a coordinated maintenance-window change. Migration 002 removes columns
that the old runner writes (`trigger_payload`, `node_id`, `input`, `output`) and
the new runner requires the replacement `stage`, `correlation_id`, and
`safe_error_code` schema. An app-only rollback across that boundary is unsafe.

1. Prepare distinct high-entropy `FLOWTENDER_API_KEY` and
   `FLOWTENDER_OPERATOR_KEY` values. Abort if they are equal. Keep actual values
   out of shell history, logs, tickets, and smoke-test output.
2. Open the maintenance window and stop all trigger traffic at ingress,
   including webhook, direct trigger, and retry POSTs. Leave operator reads
   available only if needed to drain work.
3. Wait until this count is zero before proceeding:
   `SELECT count(*) FROM public.flow_executions WHERE status = 'running';`
4. Record a non-sensitive inventory: deployed app revision and hostname,
   migration history, telemetry table/constraint names, cron job state, and
   aggregate row counts. Confirm the legacy duplicate-pair count is zero with
   `SELECT count(*) FROM (SELECT execution_id, node_id FROM public.flow_node_runs GROUP BY execution_id, node_id HAVING count(*) > 1) AS duplicates;`.
   Abort for reviewed remediation if it is nonzero. Do not select payload-bearing
   legacy columns.
5. Back up according to the Supabase recovery procedure, then apply migration
   `002_secure_redacted_telemetry.sql` once from the trusted migration runner.
   Confirm the migration record, forced RLS, named constraints, and TTL cron.
6. Explicitly purge legacy history from a trusted SQL session:
   `SELECT * FROM public.purge_all_flow_telemetry('PURGE FLOWTENDER TELEMETRY');`
   Save the returned execution/node counts and the matching purge-log row as
   evidence. Confirm both telemetry tables contain zero rows.
7. Deploy the reviewed revision to the single canonical Flowtender app. Verify
   DNS/ingress points only to that revision; do not leave a second old-schema
   worker accepting jobs.
8. While trigger ingress remains closed, run smoke tests in this order:
   health; missing/wrong/cross-boundary auth rejection; valid operator status;
   anon/authenticated RLS denial and service-role access; one controlled run
   whose execution and unique node-stage rows reach `done`/`error` with no
   payload columns; stage-2/3 retry and stage-1 re-upload rejection; then one
   authenticated webhook through the canonical hostname. Confirm all error
   bodies are fixed codes and all operator/error responses are `no-store`.
9. Review telemetry and purge evidence, then reopen webhook/direct-trigger/retry
   ingress and monitor the first controlled production run before fully
   resuming traffic.

If any migration, deploy, or smoke step fails, keep all trigger ingress closed.
Do not point the old app at the new schema: it cannot write the removed columns,
and it does not enforce the new exact-row telemetry contract. Prefer fixing
forward with the reviewed compatible revision. A true rollback requires the
database recovery plan plus the matching old app revision; validate that pair
off-ingress before restoring traffic.
