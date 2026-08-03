-- Record whether Stage 2 requirements were extracted from complete source text
-- and whether the model reached its bounded requirement output limit.
ALTER TABLE public.tenders
  ADD COLUMN IF NOT EXISTS requirements_coverage jsonb;
