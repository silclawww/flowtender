-- Destructive only inside the explicitly confirmed disposable local database.
DROP INDEX IF EXISTS public.idx_flow_executions_workflow_id;
DROP INDEX IF EXISTS public.idx_flow_executions_tender_id;
ALTER TABLE public.flow_executions
  DROP CONSTRAINT IF EXISTS flow_executions_status_check;
ALTER TABLE public.flow_node_runs
  DROP CONSTRAINT IF EXISTS flow_node_runs_status_check;
ALTER TABLE public.flow_executions
  DROP CONSTRAINT IF EXISTS flow_executions_tender_id_fkey;
