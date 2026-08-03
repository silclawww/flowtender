-- P0.5: turn abandoned paid stages into a safe recoverable state.
-- A claimed stage is stale after 10 minutes; the five-minute sweep bounds detection to 15 minutes.
-- Legacy active rows have no claim timestamp and are deliberately left for operator review.

BEGIN;

LOCK TABLE public.tenders IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.tenders
    DROP CONSTRAINT IF EXISTS tenders_processing_error_code_check;
ALTER TABLE public.tenders
    ADD CONSTRAINT tenders_processing_error_code_check
    CHECK (
        processing_error_code IS NULL
        OR processing_error_code IN (
            'FLOW_STAGE_FAILED',
            'FLOW_STAGE_TIMEOUT',
            'FLOW_TELEMETRY_FAILED',
            'UPLOAD_FLOW_REQUEST_FAILED',
            'UPLOAD_FLOW_TIMEOUT',
            'PIPELINE_STALE_TIMEOUT'
        )
    );

CREATE OR REPLACE FUNCTION public.recover_stale_tender_processing()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_affected bigint;
BEGIN
    WITH recovered AS (
        UPDATE public.tenders AS tender
        SET processing_status = 'error',
            processing_stage = CASE tender.processing_status
                WHEN 'uploading' THEN 'stage1'
                WHEN 'extracting_metadata' THEN 'stage1'
                WHEN 'extracting_details' THEN 'stage2'
                WHEN 'evaluating' THEN 'stage3'
            END,
            processing_error_code = 'PIPELINE_STALE_TIMEOUT',
            processing_error_at = clock_timestamp(),
            processing_correlation_id = gen_random_uuid()::text,
            processing_attempt_count = tender.processing_attempt_count + 1
        WHERE tender.processing_status IN (
            'uploading', 'extracting_metadata', 'extracting_details', 'evaluating'
        )
          AND tender.processing_started_at IS NOT NULL
          AND tender.processing_started_at < clock_timestamp() - interval '10 minutes'
        RETURNING 1
    )
    SELECT count(*) INTO v_affected FROM recovered;

    RETURN v_affected;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stale_tender_processing()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_stale_tender_processing()
    TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tenderly-stale-pipeline-recovery') THEN
        PERFORM cron.unschedule('tenderly-stale-pipeline-recovery');
    END IF;
    PERFORM cron.schedule(
        'tenderly-stale-pipeline-recovery',
        '*/5 * * * *',
        'SELECT public.recover_stale_tender_processing();'
    );
END;
$$;

COMMIT;
