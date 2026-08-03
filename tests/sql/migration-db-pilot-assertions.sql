DO $$
DECLARE
  v_recovered BIGINT;
BEGIN
  SELECT public.recover_stale_tender_processing() INTO v_recovered;
  IF v_recovered <> 1 THEN
    RAISE EXCEPTION 'expected one post-rollout stale claim, got %', v_recovered;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenders
    WHERE id = '20000000-0000-4000-8000-000000000001'
      AND processing_status = 'extracting_details'
      AND processing_started_at IS NULL
  ) THEN
    RAISE EXCEPTION 'legacy unclaimed row was mutated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenders
    WHERE id = '20000000-0000-4000-8000-000000000002'
      AND processing_status = 'error'
      AND processing_stage = 'stage2'
      AND processing_error_code = 'PIPELINE_STALE_TIMEOUT'
      AND processing_attempt_count = 1
      AND processing_correlation_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'claimed stale row did not become one recoverable error';
  END IF;

  IF public.recover_stale_tender_processing() <> 0 THEN
    RAISE EXCEPTION 'stale recovery was not idempotent';
  END IF;

  IF has_table_privilege('authenticated', 'public.tenders', 'INSERT')
     OR has_column_privilege('authenticated', 'public.tenders', 'processing_status', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated client can forge tender pipeline state';
  END IF;

  IF NOT has_column_privilege('authenticated', 'public.tenders', 'notes', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.tenders', 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'legitimate browser tender updates are missing';
  END IF;

  IF (SELECT count(*) FROM cron.job
      WHERE jobname = 'tenderly-stale-pipeline-recovery'
        AND schedule = '*/5 * * * *'
        AND active) <> 1 THEN
    RAISE EXCEPTION 'stale recovery cron is missing or duplicated';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.record_tender_processing_failure(uuid,uuid,text,text,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.claim_tender_processing_stage(uuid,uuid,text,boolean)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'service role processing RPC grants are missing';
  END IF;
END;
$$;
