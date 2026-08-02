-- Durable pilot admission limits shared by Tenderly and Flowtender.
-- Forward-only migration. Deploy before either P0.3 application build.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pipeline_admissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL,
  org_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upload', 'stage2', 'stage3', 'retry')),
  root_execution_id UUID,
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  CONSTRAINT pipeline_admissions_retry_root_check CHECK (
    (operation = 'retry' AND root_execution_id IS NOT NULL)
    OR (operation <> 'retry')
  ),
  CONSTRAINT pipeline_admissions_lease_check CHECK (lease_expires_at > admitted_at)
);

CREATE INDEX IF NOT EXISTS pipeline_admissions_actor_time_idx
  ON public.pipeline_admissions (actor_user_id, admitted_at DESC);
CREATE INDEX IF NOT EXISTS pipeline_admissions_org_time_idx
  ON public.pipeline_admissions (org_id, admitted_at DESC);
CREATE INDEX IF NOT EXISTS pipeline_admissions_root_time_idx
  ON public.pipeline_admissions (root_execution_id, admitted_at ASC)
  WHERE root_execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pipeline_admissions_active_idx
  ON public.pipeline_admissions (lease_expires_at)
  WHERE released_at IS NULL;

ALTER TABLE public.pipeline_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_admissions FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.pipeline_admissions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.pipeline_admissions TO service_role;

CREATE OR REPLACE FUNCTION public.acquire_pipeline_admission(
  p_actor_user_id UUID,
  p_org_id UUID,
  p_operation TEXT,
  p_retry_root_execution_id UUID DEFAULT NULL
)
RETURNS TABLE (allowed BOOLEAN, reason TEXT, lease_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_lease_id UUID;
  v_user_concurrency CONSTANT INTEGER := 1;
  v_org_concurrency CONSTANT INTEGER := 2;
  v_user_hourly CONSTANT INTEGER := 12;
  v_org_hourly CONSTANT INTEGER := 40;
  v_retry_daily CONSTANT INTEGER := 2;
  v_lease_duration CONSTANT INTERVAL := interval '12 minutes';
BEGIN
  IF p_actor_user_id IS NULL
     OR p_org_id IS NULL
     OR p_operation NOT IN ('upload', 'stage2', 'stage3', 'retry')
     OR (p_operation = 'retry') IS DISTINCT FROM (p_retry_root_execution_id IS NOT NULL)
     OR NOT EXISTS (
       SELECT 1
       FROM public.org_members
       WHERE user_id = p_actor_user_id
         AND org_id = p_org_id
     ) THEN
    RETURN QUERY SELECT false, 'invalid_context'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- Every caller takes locks in this order, serializing both principals without
  -- a process-local limiter or a deadlock-prone inverse order.
  PERFORM pg_advisory_xact_lock(hashtextextended('pipeline:user:' || p_actor_user_id::TEXT, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('pipeline:org:' || p_org_id::TEXT, 0));

  IF (SELECT count(*) FROM public.pipeline_admissions
      WHERE actor_user_id = p_actor_user_id
        AND released_at IS NULL
        AND lease_expires_at > v_now) >= v_user_concurrency THEN
    RETURN QUERY SELECT false, 'user_concurrency'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF (SELECT count(*) FROM public.pipeline_admissions
      WHERE org_id = p_org_id
        AND released_at IS NULL
        AND lease_expires_at > v_now) >= v_org_concurrency THEN
    RETURN QUERY SELECT false, 'org_concurrency'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF (SELECT count(*) FROM public.pipeline_admissions
      WHERE actor_user_id = p_actor_user_id
        AND admitted_at >= v_now - interval '1 hour') >= v_user_hourly THEN
    RETURN QUERY SELECT false, 'user_rate'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF (SELECT count(*) FROM public.pipeline_admissions
      WHERE org_id = p_org_id
        AND admitted_at >= v_now - interval '1 hour') >= v_org_hourly THEN
    RETURN QUERY SELECT false, 'org_rate'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_operation = 'retry' AND (
    SELECT count(*)
    FROM public.pipeline_admissions
    WHERE operation = 'retry'
      AND root_execution_id = p_retry_root_execution_id
      AND admitted_at >= v_now - interval '24 hours'
  ) >= v_retry_daily THEN
    RETURN QUERY SELECT false, 'retry_ceiling'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.pipeline_admissions (
    actor_user_id,
    org_id,
    operation,
    root_execution_id,
    admitted_at,
    lease_expires_at
  ) VALUES (
    p_actor_user_id,
    p_org_id,
    p_operation,
    p_retry_root_execution_id,
    v_now,
    v_now + v_lease_duration
  )
  RETURNING id INTO v_lease_id;

  RETURN QUERY SELECT true, NULL::TEXT, v_lease_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_pipeline_admission(
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_org_id UUID,
  p_operation TEXT,
  p_root_execution_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  v_claimed UUID;
BEGIN
  UPDATE public.pipeline_admissions
  SET claimed_at = clock_timestamp(),
      root_execution_id = COALESCE(root_execution_id, p_root_execution_id)
  WHERE id = p_lease_id
    AND actor_user_id = p_actor_user_id
    AND org_id = p_org_id
    AND operation = p_operation
    AND p_root_execution_id IS NOT NULL
    AND (root_execution_id IS NULL OR root_execution_id = p_root_execution_id)
    AND claimed_at IS NULL
    AND released_at IS NULL
    AND lease_expires_at > clock_timestamp()
  RETURNING id INTO v_claimed;

  RETURN v_claimed IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_pipeline_admission(p_lease_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  v_released UUID;
BEGIN
  UPDATE public.pipeline_admissions
  SET released_at = clock_timestamp()
  WHERE id = p_lease_id
    AND released_at IS NULL
  RETURNING id INTO v_released;

  RETURN v_released IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_expired_pipeline_admissions()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  v_deleted BIGINT;
BEGIN
  DELETE FROM public.pipeline_admissions
  WHERE admitted_at < clock_timestamp() - interval '48 hours'
    AND lease_expires_at < clock_timestamp();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- Rows become purge-eligible at 48 hours. With the daily job below operating
-- normally, retained admission metadata is removed in under 72 hours.

REVOKE ALL ON FUNCTION public.acquire_pipeline_admission(UUID, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_pipeline_admission(UUID, UUID, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_pipeline_admission(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_expired_pipeline_admissions()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.acquire_pipeline_admission(UUID, UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_pipeline_admission(UUID, UUID, UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_pipeline_admission(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_pipeline_admissions() TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'flowtender-pipeline-admission-ttl') THEN
    PERFORM cron.unschedule('flowtender-pipeline-admission-ttl');
  END IF;
  PERFORM cron.schedule(
    'flowtender-pipeline-admission-ttl',
    '41 3 * * *',
    'SELECT public.purge_expired_pipeline_admissions();'
  );
END;
$$;

COMMIT;
