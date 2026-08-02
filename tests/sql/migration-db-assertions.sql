DO $$
DECLARE
  v_expired RECORD;
  v_all RECORD;
  v_invalid_confirmation_accepted BOOLEAN := false;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'flow_executions'
      AND column_name IN ('trigger_payload', 'error')
  ) THEN
    RAISE EXCEPTION 'execution payload columns survived migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'flow_node_runs'
      AND column_name IN ('id', 'node_id', 'node_type', 'node_name', 'input', 'output', 'error')
  ) THEN
    RAISE EXCEPTION 'node payload columns survived migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.flow_node_runs'::regclass
      AND conname = 'flow_node_runs_execution_stage_key'
      AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'execution/stage uniqueness is missing';
  END IF;

  IF (SELECT stage FROM public.flow_node_runs
      WHERE execution_id = '10000000-0000-4000-8000-000000000001') IS DISTINCT FROM 'legacy-stage' THEN
    RAISE EXCEPTION 'legacy node_id was not backfilled into stage';
  END IF;

  -- has_table_privilege returns true when any comma-separated privilege is
  -- available, including privileges inherited through PUBLIC or role grants.
  IF has_table_privilege(
       'anon', 'public.flow_executions', 'SELECT, INSERT, UPDATE, DELETE'
     )
     OR has_table_privilege(
       'anon', 'public.flow_node_runs', 'SELECT, INSERT, UPDATE, DELETE'
     )
     OR has_table_privilege(
       'anon', 'public.flow_telemetry_purge_log', 'SELECT, INSERT, UPDATE, DELETE'
     )
     OR has_table_privilege(
       'authenticated', 'public.flow_executions', 'SELECT, INSERT, UPDATE, DELETE'
     )
     OR has_table_privilege(
       'authenticated', 'public.flow_node_runs', 'SELECT, INSERT, UPDATE, DELETE'
     )
     OR has_table_privilege(
       'authenticated', 'public.flow_telemetry_purge_log', 'SELECT, INSERT, UPDATE, DELETE'
     ) THEN
    RAISE EXCEPTION 'direct client telemetry privilege remains';
  END IF;

  IF has_function_privilege(
       'anon', 'public.purge_expired_flow_telemetry()', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'public.purge_all_flow_telemetry(text)', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.purge_expired_flow_telemetry()', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.purge_all_flow_telemetry(text)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'direct client purge-function privilege remains';
  END IF;

  -- PUBLIC is a pseudo-role, so inspect the effective default/function ACL
  -- directly instead of passing it to has_function_privilege.
  IF EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    CROSS JOIN LATERAL aclexplode(
      COALESCE(routine.proacl, acldefault('f', routine.proowner))
    ) AS privilege
    WHERE routine.oid IN (
      'public.purge_expired_flow_telemetry()'::regprocedure,
      'public.purge_all_flow_telemetry(text)'::regprocedure
    )
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC can execute a purge function';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    WHERE routine.oid IN (
      'public.purge_expired_flow_telemetry()'::regprocedure,
      'public.purge_all_flow_telemetry(text)'::regprocedure
    )
      AND (
        NOT routine.prosecdef
        OR NOT (
          COALESCE(routine.proconfig, ARRAY[]::TEXT[]) @>
          ARRAY['search_path=public, pg_temp', 'row_security=off']::TEXT[]
        )
      )
  ) THEN
    RAISE EXCEPTION 'purge function security configuration is incorrect';
  END IF;

  IF NOT has_function_privilege(
       'service_role', 'public.purge_expired_flow_telemetry()', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', 'public.purge_all_flow_telemetry(text)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'service role purge-function privilege is missing';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.flow_executions', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.flow_node_runs', 'UPDATE') THEN
    RAISE EXCEPTION 'service role telemetry privilege is missing';
  END IF;

  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'service role does not bypass forced RLS';
  END IF;

  IF NOT (
    SELECT bool_and(relforcerowsecurity)
    FROM pg_class
    WHERE oid IN (
      'public.flow_executions'::regclass,
      'public.flow_node_runs'::regclass,
      'public.flow_telemetry_purge_log'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'forced RLS is missing';
  END IF;

  IF (SELECT count(*) FROM cron.job
      WHERE jobname = 'flowtender-redacted-telemetry-ttl') <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM cron.job
       WHERE jobname = 'flowtender-redacted-telemetry-ttl'
         AND schedule = '17 3 * * *'
         AND command = 'SELECT public.purge_expired_flow_telemetry();'
         AND active
     ) THEN
    RAISE EXCEPTION 'telemetry TTL cron configuration is incorrect';
  END IF;

  INSERT INTO public.flow_executions (
    id, workflow_id, status, started_at, correlation_id
  ) VALUES (
    '10000000-0000-4000-8000-000000000002',
    'tender-stage3-evaluation',
    'running',
    now(),
    'migration-db-test'
  );

  INSERT INTO public.flow_node_runs (
    execution_id, stage, status, started_at, correlation_id
  ) VALUES (
    '10000000-0000-4000-8000-000000000002',
    'parse-evaluation',
    'running',
    now(),
    'migration-db-test'
  );

  BEGIN
    INSERT INTO public.flow_node_runs (
      execution_id, stage, status, started_at, correlation_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000002',
      'parse-evaluation',
      'running',
      now(),
      'migration-db-test'
    );
    RAISE EXCEPTION 'duplicate execution/stage was accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  SELECT * INTO v_expired FROM public.purge_expired_flow_telemetry();
  IF v_expired.flow_executions_deleted <> 1 OR v_expired.flow_node_runs_deleted <> 1 THEN
    RAISE EXCEPTION 'expired purge evidence was not exact: %, %',
      v_expired.flow_executions_deleted, v_expired.flow_node_runs_deleted;
  END IF;

  IF (SELECT count(*) FROM public.flow_executions) <> 1
     OR (SELECT count(*) FROM public.flow_node_runs) <> 1 THEN
    RAISE EXCEPTION 'expired purge removed the wrong rows';
  END IF;

  BEGIN
    PERFORM public.purge_all_flow_telemetry('wrong confirmation');
    v_invalid_confirmation_accepted := true;
  EXCEPTION
    WHEN OTHERS THEN NULL;
  END;
  IF v_invalid_confirmation_accepted THEN
    RAISE EXCEPTION 'full purge accepted an invalid confirmation';
  END IF;

  SELECT * INTO v_all
  FROM public.purge_all_flow_telemetry('PURGE FLOWTENDER TELEMETRY');
  IF v_all.flow_executions_deleted <> 1 OR v_all.flow_node_runs_deleted <> 1 THEN
    RAISE EXCEPTION 'full purge evidence was not exact: %, %',
      v_all.flow_executions_deleted, v_all.flow_node_runs_deleted;
  END IF;

  IF EXISTS (SELECT 1 FROM public.flow_executions)
     OR EXISTS (SELECT 1 FROM public.flow_node_runs) THEN
    RAISE EXCEPTION 'full purge left telemetry rows';
  END IF;
END;
$$;
