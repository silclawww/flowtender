DO $$
DECLARE
  v_expired RECORD;
  v_all RECORD;
  v_invalid_confirmation_accepted BOOLEAN := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tenders'
      AND column_name = 'requirements_coverage'
      AND data_type = 'jsonb'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'nullable jsonb requirements coverage column is missing';
  END IF;

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

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'flow_executions'
      AND indexname = 'idx_flow_executions_workflow_id'
      AND indexdef =
        'CREATE INDEX idx_flow_executions_workflow_id ON public.flow_executions USING btree (workflow_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'flow_executions'
      AND indexname = 'idx_flow_executions_tender_id'
      AND indexdef =
        'CREATE INDEX idx_flow_executions_tender_id ON public.flow_executions USING btree (tender_id)'
  ) THEN
    RAISE EXCEPTION 'flow execution lookup indexes are missing or incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.flow_executions'::regclass
      AND conname = 'flow_executions_status_check'
      AND contype = 'c'
      AND pg_get_constraintdef(oid) =
        'CHECK ((status = ANY (ARRAY[''pending''::text, ''running''::text, ''done''::text, ''error''::text, ''cancelled''::text])))'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.flow_node_runs'::regclass
      AND conname = 'flow_node_runs_status_check'
      AND contype = 'c'
      AND pg_get_constraintdef(oid) =
        'CHECK ((status = ANY (ARRAY[''pending''::text, ''running''::text, ''done''::text, ''error''::text])))'
  ) THEN
    RAISE EXCEPTION 'flow telemetry status constraints are missing or incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.flow_executions'::regclass
      AND conname = 'flow_executions_tender_id_fkey'
      AND contype = 'f'
      AND pg_get_constraintdef(oid) =
        'FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE SET NULL'
  ) THEN
    RAISE EXCEPTION 'flow execution tender foreign key is missing or incorrect';
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

DO $$
DECLARE
  v_result RECORD;
  v_lease_a UUID;
  v_lease_b UUID;
  v_root UUID := 'cccccccc-0000-4000-8000-000000000001';
  v_index INTEGER;
BEGIN
  IF has_table_privilege('anon', 'public.pipeline_admissions', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('authenticated', 'public.pipeline_admissions', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('service_role', 'public.pipeline_admissions', 'INSERT, UPDATE, DELETE')
     OR NOT has_table_privilege('service_role', 'public.pipeline_admissions', 'SELECT') THEN
    RAISE EXCEPTION 'pipeline admission table grants are incorrect';
  END IF;

  IF has_function_privilege('anon', 'public.acquire_pipeline_admission(uuid,uuid,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.acquire_pipeline_admission(uuid,uuid,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.acquire_pipeline_admission(uuid,uuid,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.claim_pipeline_admission(uuid,uuid,uuid,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.release_pipeline_admission(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'pipeline admission function grants are incorrect';
  END IF;

  IF NOT (SELECT relrowsecurity AND relforcerowsecurity
          FROM pg_class WHERE oid = 'public.pipeline_admissions'::regclass) THEN
    RAISE EXCEPTION 'pipeline admission forced RLS is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid IN (
      'public.acquire_pipeline_admission(uuid,uuid,text,uuid)'::regprocedure,
      'public.claim_pipeline_admission(uuid,uuid,uuid,text,uuid)'::regprocedure,
      'public.release_pipeline_admission(uuid)'::regprocedure,
      'public.purge_expired_pipeline_admissions()'::regprocedure
    )
      AND (NOT prosecdef OR NOT (
        COALESCE(proconfig, ARRAY[]::TEXT[]) @>
        ARRAY['search_path=public, pg_temp', 'row_security=off']::TEXT[]
      ))
  ) THEN
    RAISE EXCEPTION 'pipeline admission function security configuration is incorrect';
  END IF;

  SELECT * INTO v_result FROM public.acquire_pipeline_admission(
    'ffffffff-0000-4000-8000-000000000001',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'stage2',
    NULL
  );
  IF v_result.allowed OR v_result.reason <> 'invalid_context' THEN
    RAISE EXCEPTION 'non-member admission was accepted';
  END IF;

  SELECT * INTO v_result FROM public.acquire_pipeline_admission(
    'aaaaaaaa-0000-4000-8000-000000000001',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'stage2',
    NULL
  );
  IF NOT v_result.allowed OR v_result.lease_id IS NULL THEN
    RAISE EXCEPTION 'valid user admission was denied';
  END IF;
  v_lease_a := v_result.lease_id;

  IF NOT public.claim_pipeline_admission(
    v_lease_a,
    'aaaaaaaa-0000-4000-8000-000000000001',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'stage2',
    v_root
  ) OR public.claim_pipeline_admission(
    v_lease_a,
    'aaaaaaaa-0000-4000-8000-000000000001',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'stage2',
    v_root
  ) THEN
    RAISE EXCEPTION 'admission claim was not exactly-once';
  END IF;

  SELECT * INTO v_result FROM public.acquire_pipeline_admission(
    'aaaaaaaa-0000-4000-8000-000000000001',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'stage3',
    NULL
  );
  IF v_result.allowed OR v_result.reason <> 'user_concurrency' THEN
    RAISE EXCEPTION 'per-user concurrency limit was not enforced';
  END IF;

  SELECT * INTO v_result FROM public.acquire_pipeline_admission(
    'aaaaaaaa-0000-4000-8000-000000000002',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'stage2',
    NULL
  );
  IF NOT v_result.allowed THEN RAISE EXCEPTION 'second org slot was denied'; END IF;
  v_lease_b := v_result.lease_id;

  SELECT * INTO v_result FROM public.acquire_pipeline_admission(
    'aaaaaaaa-0000-4000-8000-000000000004',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'stage2',
    NULL
  );
  IF v_result.allowed OR v_result.reason <> 'org_concurrency' THEN
    RAISE EXCEPTION 'per-org concurrency limit was not enforced';
  END IF;

  IF NOT public.release_pipeline_admission(v_lease_a)
     OR NOT public.release_pipeline_admission(v_lease_b) THEN
    RAISE EXCEPTION 'leases did not release';
  END IF;

  DELETE FROM public.pipeline_admissions;

  INSERT INTO public.pipeline_admissions (
    actor_user_id, org_id, operation, root_execution_id,
    admitted_at, lease_expires_at, claimed_at, released_at
  ) VALUES (
    'aaaaaaaa-0000-4000-8000-000000000001',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'stage2',
    v_root,
    clock_timestamp(),
    clock_timestamp() + interval '12 minutes',
    clock_timestamp(),
    clock_timestamp()
  );

  SELECT * INTO v_result FROM public.acquire_pipeline_admission(
    'aaaaaaaa-0000-4000-8000-000000000002',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'retry',
    v_root
  );
  IF v_result.allowed OR v_result.reason <> 'retry_context_mismatch' THEN
    RAISE EXCEPTION 'retry root was accepted for a different actor';
  END IF;

  FOR v_index IN 1..2 LOOP
    SELECT * INTO v_result FROM public.acquire_pipeline_admission(
      'aaaaaaaa-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000001',
      'retry',
      v_root
    );
    IF NOT v_result.allowed THEN RAISE EXCEPTION 'retry % was denied', v_index; END IF;
    IF NOT public.claim_pipeline_admission(
      v_result.lease_id,
      'aaaaaaaa-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000001',
      'retry',
      v_root
    ) THEN RAISE EXCEPTION 'retry claim % failed', v_index; END IF;
    PERFORM public.release_pipeline_admission(v_result.lease_id);
  END LOOP;

  SELECT * INTO v_result FROM public.acquire_pipeline_admission(
    'aaaaaaaa-0000-4000-8000-000000000001',
    'bbbbbbbb-0000-4000-8000-000000000001',
    'retry',
    v_root
  );
  IF v_result.allowed OR v_result.reason <> 'retry_ceiling' THEN
    RAISE EXCEPTION 'retry ceiling was not enforced across one root';
  END IF;

  DELETE FROM public.pipeline_admissions;

  -- Seed eleven requests, then use one original upload lease for the complete
  -- twelfth request (receiver plus supplemental work). A second acquisition
  -- would become request thirteen and must be denied.
  FOR v_index IN 1..11 LOOP
    SELECT * INTO v_result FROM public.acquire_pipeline_admission(
      'aaaaaaaa-0000-4000-8000-000000000003',
      'bbbbbbbb-0000-4000-8000-000000000002',
      'upload',
      NULL
    );
    IF NOT v_result.allowed THEN RAISE EXCEPTION 'user rate seed % was denied', v_index; END IF;
    PERFORM public.release_pipeline_admission(v_result.lease_id);
  END LOOP;

  SELECT * INTO v_result FROM public.acquire_pipeline_admission(
    'aaaaaaaa-0000-4000-8000-000000000003',
    'bbbbbbbb-0000-4000-8000-000000000002',
    'upload',
    NULL
  );
  IF NOT v_result.allowed THEN RAISE EXCEPTION 'twelfth upload was denied'; END IF;
  v_lease_a := v_result.lease_id;
  IF NOT public.claim_pipeline_admission(
    v_lease_a,
    'aaaaaaaa-0000-4000-8000-000000000003',
    'bbbbbbbb-0000-4000-8000-000000000002',
    'upload',
    'dddddddd-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'twelfth upload receiver claim failed';
  END IF;
  -- Supplemental extraction stays under v_lease_a: deliberately no acquire.
  PERFORM public.release_pipeline_admission(v_lease_a);

  SELECT * INTO v_result FROM public.acquire_pipeline_admission(
    'aaaaaaaa-0000-4000-8000-000000000003',
    'bbbbbbbb-0000-4000-8000-000000000002',
    'upload',
    NULL
  );
  IF v_result.allowed OR v_result.reason <> 'user_rate' THEN
    RAISE EXCEPTION 'per-user hourly rate was not enforced';
  END IF;

  INSERT INTO public.pipeline_admissions (
    actor_user_id, org_id, operation, admitted_at, lease_expires_at, released_at
  )
  SELECT gen_random_uuid(),
         'bbbbbbbb-0000-4000-8000-000000000002',
         'upload',
         clock_timestamp() - interval '20 minutes',
         clock_timestamp() - interval '19 minutes',
         clock_timestamp() - interval '19 minutes'
  FROM generate_series(1, 40);

  SELECT * INTO v_result FROM public.acquire_pipeline_admission(
    'aaaaaaaa-0000-4000-8000-000000000005',
    'bbbbbbbb-0000-4000-8000-000000000002',
    'stage2',
    NULL
  );
  IF v_result.allowed OR v_result.reason <> 'org_rate' THEN
    RAISE EXCEPTION 'per-org hourly rate was not enforced';
  END IF;

  INSERT INTO public.pipeline_admissions (
    actor_user_id, org_id, operation, admitted_at, lease_expires_at, released_at
  ) VALUES (
    'aaaaaaaa-0000-4000-8000-000000000005',
    'bbbbbbbb-0000-4000-8000-000000000002',
    'upload',
    clock_timestamp() - interval '50 hours',
    clock_timestamp() - interval '49 hours',
    clock_timestamp() - interval '49 hours'
  );
  IF public.purge_expired_pipeline_admissions() <> 1 THEN
    RAISE EXCEPTION '48-hour cleanup did not remove exactly the expired row';
  END IF;

  IF (SELECT count(*) FROM cron.job
      WHERE jobname = 'flowtender-pipeline-admission-ttl'
        AND schedule = '41 3 * * *'
        AND command = 'SELECT public.purge_expired_pipeline_admissions();'
        AND active) <> 1 THEN
    RAISE EXCEPTION 'pipeline admission cleanup job is incorrect';
  END IF;
END;
$$;
