-- P0.5: make the tender row the authority for paid pipeline stage claims.
-- Forward-only; deploy after 016_durable_processing_failures.sql.

BEGIN;

ALTER TABLE public.tenders
    ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_tender_processing_stage(
    p_tender_id uuid,
    p_org_id uuid,
    p_processing_stage text,
    p_is_retry boolean
)
RETURNS TABLE (
    claimed boolean,
    reason text,
    processing_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_current_status text;
    v_target_status text;
BEGIN
    IF p_tender_id IS NULL OR p_org_id IS NULL OR p_is_retry IS NULL
       OR p_processing_stage NOT IN ('stage1', 'stage2', 'stage3') THEN
        RAISE EXCEPTION 'invalid stage claim' USING ERRCODE = '22023';
    END IF;

    v_target_status := CASE p_processing_stage
        WHEN 'stage1' THEN 'extracting_metadata'
        WHEN 'stage2' THEN 'extracting_details'
        WHEN 'stage3' THEN 'evaluating'
    END;

    UPDATE public.tenders AS tender
    SET processing_status = v_target_status,
        processing_stage = p_processing_stage,
        processing_started_at = clock_timestamp(),
        processing_error_code = NULL,
        processing_error_at = NULL,
        processing_correlation_id = NULL
    WHERE tender.id = p_tender_id
      AND tender.org_id = p_org_id
      AND (
        (NOT p_is_retry AND (
          (p_processing_stage = 'stage1' AND tender.processing_status = 'uploading')
          OR (p_processing_stage = 'stage2' AND tender.processing_status = 'metadata_ready')
          OR (p_processing_stage = 'stage3' AND tender.processing_status IN ('details_ready', 'requirements_ready'))
        ))
        OR (p_is_retry
            AND tender.processing_status = 'error'
            AND tender.processing_stage = p_processing_stage)
      )
    RETURNING tender.processing_status INTO v_current_status;

    IF FOUND THEN
        RETURN QUERY SELECT true, NULL::text, v_current_status;
        RETURN;
    END IF;

    SELECT tender.processing_status
    INTO v_current_status
    FROM public.tenders AS tender
    WHERE tender.id = p_tender_id
      AND tender.org_id = p_org_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'not_found'::text, NULL::text;
    ELSIF v_current_status = v_target_status THEN
        RETURN QUERY SELECT false, 'already_in_flight'::text, v_current_status;
    ELSIF (p_processing_stage = 'stage1' AND v_current_status IN (
              'metadata_ready', 'extracting_details', 'details_ready',
              'requirements_ready', 'evaluating', 'complete'
          ))
       OR (p_processing_stage = 'stage2' AND v_current_status IN (
              'details_ready', 'requirements_ready', 'evaluating', 'complete'
          ))
       OR (p_processing_stage = 'stage3' AND v_current_status = 'complete') THEN
        RETURN QUERY SELECT false, 'already_complete'::text, v_current_status;
    ELSE
        RETURN QUERY SELECT false, 'invalid_transition'::text, v_current_status;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_tender_processing_stage(uuid, uuid, text, boolean)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_tender_processing_stage(uuid, uuid, text, boolean)
    TO service_role;

COMMIT;
