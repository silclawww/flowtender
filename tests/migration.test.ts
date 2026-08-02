import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = new URL('../supabase/migrations/002_secure_redacted_telemetry.sql', import.meta.url);

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
