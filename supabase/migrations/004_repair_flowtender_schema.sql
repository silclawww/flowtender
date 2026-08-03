-- Restore five migration-001 objects absent from the linked production schema.
-- Forward-only and retry-safe; existing rows must satisfy the intended rules.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_flow_executions_workflow_id
  ON public.flow_executions (workflow_id);
CREATE INDEX IF NOT EXISTS idx_flow_executions_tender_id
  ON public.flow_executions (tender_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.flow_executions'::regclass
      AND conname = 'flow_executions_status_check'
  ) THEN
    ALTER TABLE public.flow_executions
      ADD CONSTRAINT flow_executions_status_check
      CHECK (status IN ('pending', 'running', 'done', 'error', 'cancelled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.flow_node_runs'::regclass
      AND conname = 'flow_node_runs_status_check'
  ) THEN
    ALTER TABLE public.flow_node_runs
      ADD CONSTRAINT flow_node_runs_status_check
      CHECK (status IN ('pending', 'running', 'done', 'error'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.flow_executions'::regclass
      AND conname = 'flow_executions_tender_id_fkey'
  ) THEN
    ALTER TABLE public.flow_executions
      ADD CONSTRAINT flow_executions_tender_id_fkey
      FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE SET NULL;
  END IF;
END;
$$;

COMMIT;
