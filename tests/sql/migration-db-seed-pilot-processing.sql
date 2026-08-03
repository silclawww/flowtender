DELETE FROM public.tenders
WHERE id IN (
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002'
);

INSERT INTO public.tenders (
  id, org_id, processing_status, updated_at
) VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'extracting_details',
    clock_timestamp() - interval '1 day'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'metadata_ready',
    clock_timestamp()
  );

DO $$
DECLARE
  v_claim RECORD;
BEGIN
  SELECT * INTO v_claim
  FROM public.claim_tender_processing_stage(
    '20000000-0000-4000-8000-000000000002',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'stage2',
    false
  );

  IF NOT v_claim.claimed OR v_claim.processing_status <> 'extracting_details' THEN
    RAISE EXCEPTION 'post-rollout stage claim failed';
  END IF;
END;
$$;

UPDATE public.tenders
SET processing_started_at = clock_timestamp() - interval '11 minutes'
WHERE id = '20000000-0000-4000-8000-000000000002';
