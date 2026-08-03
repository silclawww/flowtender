-- P0.5: persist safe pipeline failure metadata through one atomic, scoped RPC.
-- Forward-only and safe to retry after a partially applied migration.

BEGIN;

LOCK TABLE public.tenders IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.tenders
    ADD COLUMN IF NOT EXISTS processing_stage text,
    ADD COLUMN IF NOT EXISTS processing_error_code text,
    ADD COLUMN IF NOT EXISTS processing_error_at timestamptz,
    ADD COLUMN IF NOT EXISTS processing_correlation_id text,
    ADD COLUMN IF NOT EXISTS processing_attempt_count bigint DEFAULT 0;

UPDATE public.tenders
SET processing_attempt_count = 0
WHERE processing_attempt_count IS NULL;

ALTER TABLE public.tenders
    ALTER COLUMN processing_attempt_count SET DEFAULT 0,
    ALTER COLUMN processing_attempt_count SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.tenders'::regclass
          AND conname = 'tenders_processing_stage_check'
    ) THEN
        ALTER TABLE public.tenders
            ADD CONSTRAINT tenders_processing_stage_check
            CHECK (processing_stage IS NULL OR processing_stage IN ('stage1', 'stage2', 'stage3'));
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.tenders'::regclass
          AND conname = 'tenders_processing_error_code_check'
    ) THEN
        ALTER TABLE public.tenders
            ADD CONSTRAINT tenders_processing_error_code_check
            CHECK (
                processing_error_code IS NULL
                OR processing_error_code IN (
                    'FLOW_STAGE_FAILED',
                    'FLOW_STAGE_TIMEOUT',
                    'FLOW_TELEMETRY_FAILED',
                    'UPLOAD_FLOW_REQUEST_FAILED',
                    'UPLOAD_FLOW_TIMEOUT'
                )
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.tenders'::regclass
          AND conname = 'tenders_processing_correlation_id_check'
    ) THEN
        ALTER TABLE public.tenders
            ADD CONSTRAINT tenders_processing_correlation_id_check
            CHECK (
                processing_correlation_id IS NULL
                OR processing_correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.tenders'::regclass
          AND conname = 'tenders_processing_attempt_count_check'
    ) THEN
        ALTER TABLE public.tenders
            ADD CONSTRAINT tenders_processing_attempt_count_check
            CHECK (processing_attempt_count >= 0);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_tender_processing_failure(
    p_tender_id uuid,
    p_org_id uuid,
    p_processing_stage text,
    p_processing_error_code text,
    p_processing_correlation_id text
)
RETURNS TABLE (
    tender_id uuid,
    org_id uuid,
    affected_count bigint,
    processing_attempt_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_tender_id IS NULL OR p_org_id IS NULL THEN
        RAISE EXCEPTION 'tender and organisation are required' USING ERRCODE = '22023';
    END IF;

    IF p_processing_stage IS NULL
       OR p_processing_stage NOT IN ('stage1', 'stage2', 'stage3') THEN
        RAISE EXCEPTION 'invalid processing stage' USING ERRCODE = '22023';
    END IF;

    IF p_processing_error_code IS NULL
       OR p_processing_error_code NOT IN (
           'FLOW_STAGE_FAILED',
           'FLOW_STAGE_TIMEOUT',
           'FLOW_TELEMETRY_FAILED',
           'UPLOAD_FLOW_REQUEST_FAILED',
           'UPLOAD_FLOW_TIMEOUT'
       ) THEN
        RAISE EXCEPTION 'invalid processing error code' USING ERRCODE = '22023';
    END IF;

    IF p_processing_correlation_id IS NULL
       OR p_processing_correlation_id !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
        RAISE EXCEPTION 'invalid processing correlation id' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    UPDATE public.tenders AS tender
    SET processing_status = 'error',
        processing_stage = CASE
            WHEN tender.processing_correlation_id IS NOT DISTINCT FROM p_processing_correlation_id
                THEN tender.processing_stage
            ELSE p_processing_stage
        END,
        processing_error_code = CASE
            WHEN tender.processing_correlation_id IS NOT DISTINCT FROM p_processing_correlation_id
                THEN tender.processing_error_code
            ELSE p_processing_error_code
        END,
        processing_error_at = CASE
            WHEN tender.processing_correlation_id IS NOT DISTINCT FROM p_processing_correlation_id
                THEN tender.processing_error_at
            ELSE clock_timestamp()
        END,
        processing_correlation_id = CASE
            WHEN tender.processing_correlation_id IS NOT DISTINCT FROM p_processing_correlation_id
                THEN tender.processing_correlation_id
            ELSE p_processing_correlation_id
        END,
        processing_attempt_count = CASE
            WHEN tender.processing_correlation_id IS NOT DISTINCT FROM p_processing_correlation_id
                THEN tender.processing_attempt_count
            ELSE tender.processing_attempt_count + 1
        END
    WHERE tender.id = p_tender_id
      AND tender.org_id = p_org_id
    RETURNING
        tender.id,
        tender.org_id,
        1::bigint,
        tender.processing_attempt_count;
END;
$$;

REVOKE ALL ON FUNCTION public.record_tender_processing_failure(uuid, uuid, text, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_tender_processing_failure(uuid, uuid, text, text, text)
    TO service_role;

COMMIT;
