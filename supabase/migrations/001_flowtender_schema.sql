-- flowtender: workflow execution tracking tables
-- These live alongside Tenderly's tables in the same Supabase project

CREATE TABLE IF NOT EXISTS public.flow_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id TEXT NOT NULL,
  trigger_payload JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  tender_id UUID REFERENCES public.tenders(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INT,
  error TEXT,
  CONSTRAINT flow_executions_status_check CHECK (status IN ('pending','running','done','error','cancelled'))
);

CREATE TABLE IF NOT EXISTS public.flow_node_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES public.flow_executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_name TEXT,
  input JSONB,
  output JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INT,
  CONSTRAINT flow_node_runs_status_check CHECK (status IN ('pending','running','done','error'))
);

CREATE INDEX IF NOT EXISTS idx_flow_executions_workflow_id ON public.flow_executions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_flow_executions_tender_id ON public.flow_executions(tender_id);
CREATE INDEX IF NOT EXISTS idx_flow_executions_started_at ON public.flow_executions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_flow_node_runs_execution_id ON public.flow_node_runs(execution_id);

-- RLS: service role bypasses, anon/authenticated can read their own executions
ALTER TABLE public.flow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_node_runs ENABLE ROW LEVEL SECURITY;

-- For now: allow all reads (inspector UI needs to display executions)
CREATE POLICY "flow_executions: service role full access" ON public.flow_executions
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "flow_node_runs: service role full access" ON public.flow_node_runs
  FOR ALL USING (true) WITH CHECK (true);
