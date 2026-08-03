import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = () => readFileSync(
  new URL('../supabase/migrations/003_pipeline_admission.sql', import.meta.url),
  'utf8',
);

test('admission ledger is service-only, payload-free, and retry-safe', () => {
  const sql = migration();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.pipeline_admissions/);
  assert.match(sql, /actor_user_id UUID NOT NULL/);
  assert.match(sql, /org_id UUID NOT NULL/);
  assert.match(sql, /root_execution_id UUID/);
  assert.doesNotMatch(sql, /payload|document|prompt|response|secret/i);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\.pipeline_admissions FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(sql, /GRANT SELECT ON TABLE public\.pipeline_admissions TO service_role/);
});

test('atomic policy centrally enforces both principals and the retry ceiling', () => {
  const sql = migration();
  assert.match(sql, /v_user_concurrency\s+CONSTANT INTEGER := 1/);
  assert.match(sql, /v_org_concurrency\s+CONSTANT INTEGER := 2/);
  assert.match(sql, /v_user_hourly\s+CONSTANT INTEGER := 12/);
  assert.match(sql, /v_org_hourly\s+CONSTANT INTEGER := 40/);
  assert.match(sql, /v_retry_daily\s+CONSTANT INTEGER := 2/);
  assert.equal((sql.match(/pg_advisory_xact_lock/g) ?? []).length >= 3, true);
  assert.match(sql, /pipeline:retry-root:/);
  assert.match(sql, /retry_context_mismatch/);
  assert.match(sql, /operation IN \('stage2', 'stage3'\)[\s\S]*claimed_at IS NOT NULL[\s\S]*actor_user_id = p_actor_user_id[\s\S]*org_id = p_org_id/);
  assert.match(sql, /operation = 'retry'[\s\S]*root_execution_id = p_retry_root_execution_id/);
});

test('leases are claimable once, expire safely, and are purged on a bounded schedule', () => {
  const sql = migration();
  assert.match(sql, /interval '12 minutes'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.claim_pipeline_admission/);
  assert.match(sql, /claimed_at IS NULL/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.release_pipeline_admission/);
  assert.match(sql, /interval '48 hours'/);
  assert.match(sql, /flowtender-pipeline-admission-ttl/);
  assert.match(sql, /cron\.schedule/);
});

test('migration is retry-safe and leaves the strict telemetry allowlist unchanged', () => {
  const sql = migration();
  assert.match(sql, /CREATE INDEX IF NOT EXISTS pipeline_admissions_root_time_idx/);
  assert.doesNotMatch(sql, /ALTER TABLE public\.flow_executions/);

  const script = readFileSync(new URL('../scripts/test-migration-db.sh', import.meta.url), 'utf8');
  assert.equal((script.match(/003_pipeline_admission\.sql/g) ?? []).length, 2);
  assert.match(script, /test-admission-concurrency\.sh/);

  const concurrency = readFileSync(
    new URL('../scripts/test-admission-concurrency.sh', import.meta.url),
    'utf8',
  );
  assert.match(concurrency, /for session_index in 1 2 3 4/);
  assert.match(concurrency, /retry_ceiling/);
  assert.match(concurrency, /retry_context_mismatch/);
});
