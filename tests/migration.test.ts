import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = new URL('../supabase/migrations/002_secure_redacted_telemetry.sql', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);
const dbTestPath = new URL('../scripts/test-migration-db.sh', import.meta.url);
const dbAssertionsPath = new URL('./sql/migration-db-assertions.sql', import.meta.url);
const rolloutPath = new URL('../docs/flowtender-telemetry-rollout.md', import.meta.url);

function migration(): string {
  return readFileSync(migrationPath, 'utf8');
}

test('forward migration removes allow-all policies and direct client grants', () => {
  const sql = migration();
  assert.match(sql, /DROP POLICY IF EXISTS "flow_executions: service role full access"/);
  assert.match(sql, /DROP POLICY IF EXISTS "flow_node_runs: service role full access"/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\.flow_executions FROM anon, authenticated/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\.flow_node_runs FROM anon, authenticated/);
  assert.match(sql, /GRANT ALL PRIVILEGES ON TABLE public\.flow_executions TO service_role/);
  assert.match(sql, /GRANT ALL PRIVILEGES ON TABLE public\.flow_node_runs TO service_role/);
});

test('forward migration physically removes sensitive payload columns', () => {
  const sql = migration();
  for (const column of ['trigger_payload', 'id', 'input', 'output', 'error', 'node_type', 'node_name']) {
    assert.match(sql, new RegExp(`DROP COLUMN IF EXISTS ${column}`));
  }
  assert.match(sql, /ADD COLUMN IF NOT EXISTS safe_error_code/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS correlation_id/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS stage/);
  assert.match(sql, /flow_node_runs_stage_check/);
  assert.match(sql, /flow_executions_workflow_id_check/);
});

test('schema hardening is safe to retry and enforces one node row per execution stage', () => {
  const sql = migration();
  assert.match(sql, /FROM pg_attribute/);
  assert.match(sql, /attname = 'node_id'/);
  assert.match(sql, /EXECUTE[\s\S]*UPDATE public\.flow_node_runs/);
  assert.match(sql, /FROM pg_constraint/);
  assert.match(sql, /flow_node_runs_execution_stage_key/);
  assert.match(sql, /UNIQUE \(execution_id, stage\)/);
});

test('migration defines automatic seven-day TTL and an explicit confirmed purge', () => {
  const sql = migration();
  assert.match(sql, /interval '7 days'/i);
  assert.match(sql, /cron\.schedule/);
  assert.match(sql, /purge_all_flow_telemetry\(confirmation text\)/);
  assert.match(sql, /confirmation IS DISTINCT FROM 'PURGE FLOWTENDER TELEMETRY'/);
  assert.match(sql, /flow_telemetry_purge_log/);
  assert.match(sql, /purged_at/);
  assert.match(sql, /flow_executions_deleted/);
  assert.match(sql, /flow_node_runs_deleted/);
});

test('purges serialize writers and derive evidence from deleted rows', () => {
  const sql = migration();
  const advisoryLocks = sql.match(/pg_advisory_xact_lock/g) ?? [];
  const tableLocks = sql.match(/LOCK TABLE public\.flow_executions, public\.flow_node_runs\s+IN ACCESS EXCLUSIVE MODE;/g) ?? [];
  const returningDeletes = sql.match(/DELETE FROM public\.flow_(?:executions|node_runs)[\s\S]*?RETURNING/g) ?? [];

  assert.equal(advisoryLocks.length, 2);
  assert.equal(tableLocks.length, 2);
  assert.ok(returningDeletes.length >= 4);
  assert.equal((sql.match(/SET row_security = off/g) ?? []).length, 2);
  assert.doesNotMatch(sql, /GET DIAGNOSTICS/);
});

test('daily TTL enforcement documents the seven-day cutoff and under-eight-day maximum', () => {
  const sql = migration();
  const readme = readFileSync(readmePath, 'utf8');

  assert.match(sql, /'17 3 \* \* \*'/);
  assert.match(readme, /older than seven days/i);
  assert.match(readme, /daily at 03:17 UTC/i);
  assert.match(readme, /less than eight days/i);
  assert.doesNotMatch(`${sql}\n${readme}`, /at most (?:7|seven) days/i);
});

test('a guarded disposable-database gate applies 001 then retry-safe 002', () => {
  const script = readFileSync(dbTestPath, 'utf8');
  assert.match(script, /FLOWTENDER_TEST_DATABASE_DISPOSABLE/);
  assert.match(script, /refusing non-local database URL/);
  assert.match(script, /001_flowtender_schema\.sql/);
  assert.equal((script.match(/002_secure_redacted_telemetry\.sql/g) ?? []).length, 2);
  assert.match(script, /migration-db-assertions\.sql/);
});

test('disposable database assertions verify the complete telemetry privilege boundary', () => {
  const sql = readFileSync(dbAssertionsPath, 'utf8');

  for (const role of ['anon', 'authenticated']) {
    for (const table of ['flow_executions', 'flow_node_runs', 'flow_telemetry_purge_log']) {
      assert.match(
        sql,
        new RegExp(
          `'${role}',\\s*'public\\.${table}',\\s*'SELECT, INSERT, UPDATE, DELETE'`,
        ),
      );
    }
    for (const signature of [
      'purge_expired_flow_telemetry\\(\\)',
      'purge_all_flow_telemetry\\(text\\)',
    ]) {
      assert.match(
        sql,
        new RegExp(`'${role}',\\s*'public\\.${signature}',\\s*'EXECUTE'`),
      );
    }
  }
  assert.match(sql, /has_function_privilege/);
  assert.match(sql, /aclexplode/);
  assert.match(sql, /prosecdef/);
  assert.match(sql, /search_path=public, pg_temp/);
  assert.match(sql, /row_security=off/);
  assert.match(sql, /FROM cron\.job/);
  assert.match(sql, /schedule = '17 3 \* \* \*'/);
  assert.match(sql, /command = 'SELECT public\.purge_expired_flow_telemetry\(\);'/);
});

test('rollout recovery evidence forbids raw exports and records backup expiry', () => {
  const rollout = readFileSync(rolloutPath, 'utf8');

  assert.match(rollout, /approved platform recovery mechanism/i);
  assert.match(rollout, /must not create[^.]*logical dump/i);
  assert.match(rollout, /raw telemetry export/i);
  assert.match(rollout, /retention/i);
  assert.match(rollout, /expiry/i);
});
