INSERT INTO public.flow_executions (
  id,
  workflow_id,
  trigger_payload,
  status,
  started_at
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  'tender-stage2-requirements',
  '{"must_be_removed":"legacy payload"}'::jsonb,
  'done',
  now() - interval '8 days'
);

INSERT INTO public.flow_node_runs (
  id,
  execution_id,
  node_id,
  node_type,
  input,
  output,
  status,
  started_at
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'legacy-stage',
  'code',
  '{"must_be_removed":"legacy input"}'::jsonb,
  '{"must_be_removed":"legacy output"}'::jsonb,
  'done',
  now() - interval '8 days'
);
