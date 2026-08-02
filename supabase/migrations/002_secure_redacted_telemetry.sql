-- Flowtender pilot hardening: redacted, service-only, short-lived telemetry.
-- Forward-only migration. Do not edit 001_flowtender_schema.sql.

-- Remove payload-bearing columns and replace them with an explicit safe allowlist.
ALTER TABLE public.flow_executions
  ADD COLUMN IF NOT EXISTS safe_error_code TEXT,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;

ALTER TABLE public.flow_node_runs
  ADD COLUMN IF NOT EXISTS stage TEXT,
  ADD COLUMN IF NOT EXISTS safe_error_code TEXT,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;

-- Preserve only the non-sensitive stage identifier while upgrading existing rows.
UPDATE public.flow_node_runs
SET stage = COALESCE(NULLIF(node_id, ''), 'unknown')
WHERE stage IS NULL;

ALTER TABLE public.flow_node_runs
  ALTER COLUMN stage SET NOT NULL;

ALTER TABLE public.flow_executions
  DROP COLUMN IF EXISTS trigger_payload,
  DROP COLUMN IF EXISTS error;

ALTER TABLE public.flow_node_runs
  DROP COLUMN IF EXISTS id,
  DROP COLUMN IF EXISTS input,
  DROP COLUMN IF EXISTS output,
  DROP COLUMN IF EXISTS error,
  DROP COLUMN IF EXISTS node_type,
  DROP COLUMN IF EXISTS node_name,
  DROP COLUMN IF EXISTS node_id;

ALTER TABLE public.flow_executions
  ADD CONSTRAINT flow_executions_workflow_id_check
    CHECK (workflow_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  ADD CONSTRAINT flow_executions_safe_error_code_check
    CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[A-Z0-9_]{1,64}$'),
  ADD CONSTRAINT flow_executions_correlation_id_check
    CHECK (correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT flow_executions_duration_ms_check
    CHECK (duration_ms IS NULL OR duration_ms >= 0);

ALTER TABLE public.flow_node_runs
  ADD CONSTRAINT flow_node_runs_stage_check
    CHECK (stage ~ '^[A-Za-z0-9_-]{1,128}$'),
  ADD CONSTRAINT flow_node_runs_safe_error_code_check
    CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[A-Z0-9_]{1,64}$'),
  ADD CONSTRAINT flow_node_runs_correlation_id_check
    CHECK (correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT flow_node_runs_duration_ms_check
    CHECK (duration_ms IS NULL OR duration_ms >= 0);

-- The old policies were named for service role but applied USING (true) to every role.
DROP POLICY IF EXISTS "flow_executions: service role full access" ON public.flow_executions;
DROP POLICY IF EXISTS "flow_node_runs: service role full access" ON public.flow_node_runs;

ALTER TABLE public.flow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_executions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.flow_node_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_node_runs FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.flow_executions FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.flow_node_runs FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.flow_executions FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.flow_node_runs FROM anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.flow_executions TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.flow_node_runs TO service_role;

-- Purge evidence intentionally contains only a date and non-sensitive row counts.
CREATE TABLE IF NOT EXISTS public.flow_telemetry_purge_log (
  purged_at TIMESTAMPTZ PRIMARY KEY DEFAULT clock_timestamp(),
  flow_executions_deleted BIGINT NOT NULL CHECK (flow_executions_deleted >= 0),
  flow_node_runs_deleted BIGINT NOT NULL CHECK (flow_node_runs_deleted >= 0)
);

ALTER TABLE public.flow_telemetry_purge_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_telemetry_purge_log FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.flow_telemetry_purge_log FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.flow_telemetry_purge_log TO service_role;

-- Retention cutoff: redacted telemetry becomes eligible for deletion once it is
-- older than 7 days. The job runs daily at 03:17 UTC, so normal maximum
-- retention is under 8 days (the 7-day cutoff plus less than 24 hours).
-- Missed or disabled scheduler runs can extend that window.
CREATE OR REPLACE FUNCTION public.purge_expired_flow_telemetry()
RETURNS TABLE (
  purged_at TIMESTAMPTZ,
  flow_executions_deleted BIGINT,
  flow_node_runs_deleted BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_purged_at TIMESTAMPTZ := clock_timestamp();
  v_execution_count BIGINT;
  v_node_count BIGINT;
BEGIN
  SELECT count(*)
    INTO v_node_count
  FROM public.flow_node_runs AS node_run
  JOIN public.flow_executions AS execution
    ON execution.id = node_run.execution_id
  WHERE execution.started_at < now() - interval '7 days';

  DELETE FROM public.flow_executions
  WHERE started_at < now() - interval '7 days';
  GET DIAGNOSTICS v_execution_count = ROW_COUNT;

  INSERT INTO public.flow_telemetry_purge_log (
    purged_at,
    flow_executions_deleted,
    flow_node_runs_deleted
  ) VALUES (v_purged_at, v_execution_count, v_node_count);

  RETURN QUERY SELECT v_purged_at, v_execution_count, v_node_count;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_flow_telemetry() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_flow_telemetry() TO service_role;

-- Existing history is removed only by an operator explicitly supplying the phrase.
-- Invoke from a trusted SQL session; do not expose this function through the app.
--   SELECT * FROM public.purge_all_flow_telemetry('PURGE FLOWTENDER TELEMETRY');
CREATE OR REPLACE FUNCTION public.purge_all_flow_telemetry(confirmation text)
RETURNS TABLE (
  purged_at TIMESTAMPTZ,
  flow_executions_deleted BIGINT,
  flow_node_runs_deleted BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_purged_at TIMESTAMPTZ := clock_timestamp();
  v_execution_count BIGINT;
  v_node_count BIGINT;
BEGIN
  IF confirmation IS DISTINCT FROM 'PURGE FLOWTENDER TELEMETRY' THEN
    RAISE EXCEPTION 'Explicit purge confirmation phrase required';
  END IF;

  DELETE FROM public.flow_node_runs;
  GET DIAGNOSTICS v_node_count = ROW_COUNT;

  DELETE FROM public.flow_executions;
  GET DIAGNOSTICS v_execution_count = ROW_COUNT;

  INSERT INTO public.flow_telemetry_purge_log (
    purged_at,
    flow_executions_deleted,
    flow_node_runs_deleted
  ) VALUES (v_purged_at, v_execution_count, v_node_count);

  RETURN QUERY SELECT v_purged_at, v_execution_count, v_node_count;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_all_flow_telemetry(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_all_flow_telemetry(text) TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'flowtender-redacted-telemetry-ttl') THEN
    PERFORM cron.unschedule('flowtender-redacted-telemetry-ttl');
  END IF;

  PERFORM cron.schedule(
    'flowtender-redacted-telemetry-ttl',
    '17 3 * * *',
    'SELECT public.purge_expired_flow_telemetry();'
  );
END;
$$;
