-- Destructive only inside the explicitly confirmed disposable local database.
DROP TABLE IF EXISTS public.flow_telemetry_purge_log CASCADE;
DROP TABLE IF EXISTS public.flow_node_runs CASCADE;
DROP TABLE IF EXISTS public.flow_executions CASCADE;
DROP TABLE IF EXISTS public.pipeline_admissions CASCADE;
DROP TABLE IF EXISTS public.org_members CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE TABLE IF NOT EXISTS public.tenders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);
CREATE TABLE public.org_members (
  user_id UUID NOT NULL,
  org_id UUID NOT NULL,
  PRIMARY KEY (user_id, org_id)
);
INSERT INTO public.org_members (user_id, org_id) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000002'),
  ('aaaaaaaa-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-000000000005', 'bbbbbbbb-0000-4000-8000-000000000002');
