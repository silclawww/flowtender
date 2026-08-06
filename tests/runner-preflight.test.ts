import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkflowRunner } from '../lib/runner/runner.ts';
import {
  materializeWorkflowPayload,
  preflightWorkflowPayload,
} from '../lib/tenant-context.ts';
import { TelemetryPersistenceError } from '../lib/telemetry-persistence.ts';
import type { WorkflowDefinition } from '../types/workflow.ts';

const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';
const orgId = '3edb0931-87a3-45a6-a8f1-c1e87d539596';
const actorId = 'fca2e00f-80ad-4c6c-afbb-392cf49eb7b6';
const admissionId = 'c2b37af4-c299-4db7-859f-8423c3230d70';
const otherTenderId = '961737c9-51a7-419f-a900-962a30a2df5b';
const otherOrgId = 'c63aaab6-60ff-4297-b37a-6e443e5198be';

function rejectingClient() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    client: {
      from() {
        calls += 1;
        throw new Error('database should not be reached');
      },
    },
  };
}

for (const workflowId of [
  'tender-stage1-pdf',
  'tender-stage1-gaeb',
  'tender-stage2-requirements',
  'tender-stage3-evaluation',
]) {
  test(`${workflowId} rejects invalid admission context before DB or workflow loading`, async () => {
    for (const payload of [
      null,
      [],
      {},
      { tender_id: tenderId },
      { org_id: orgId },
      { tender_id: tenderId, org_id: orgId, user_id: actorId },
      { tender_id: 'customer-content-not-a-uuid', org_id: orgId },
      { tender_id: tenderId, org_id: orgId, user_id: 'customer-content-not-a-uuid', admission_id: admissionId },
      { body: { tender_id: tenderId, org_id: 'customer-content-not-a-uuid' } },
      {
        tender_id: tenderId,
        org_id: orgId,
        user_id: actorId,
        admission_id: admissionId,
        body: { tender_id: otherTenderId, org_id: orgId },
      },
      {
        tender_id: tenderId,
        org_id: orgId,
        user_id: actorId,
        admission_id: admissionId,
        body: { tender_id: tenderId, org_id: otherOrgId },
      },
      {
        tender_id: tenderId,
        org_id: orgId,
        user_id: actorId,
        admission_id: admissionId,
        body: { tender_id: tenderId, org_id: orgId, user_id: otherTenderId },
      },
      {
        tender_id: tenderId,
        org_id: orgId,
        user_id: actorId,
        admission_id: admissionId,
        body: { tender_id: tenderId, org_id: orgId, admission_id: otherTenderId },
      },
    ]) {
      const database = rejectingClient();
      let workflowLoads = 0;
      const runner = new WorkflowRunner(database.client as never, () => {
        workflowLoads += 1;
        throw new Error('workflow nodes should not be reached');
      });

      await assert.rejects(
        () => runner.run(workflowId, payload as Record<string, unknown>),
        (error: unknown) => {
          assert.equal((error as { status?: number }).status, 503);
          assert.equal((error as { code?: string }).code, 'ADMISSION_UNAVAILABLE');
          assert.doesNotMatch(String(error), /customer-content/);
          return true;
        },
      );
      assert.equal(database.calls, 0);
      assert.equal(workflowLoads, 0);
    }
  });
}

test('valid direct and wrapped Stage 2/3 contexts become dual-ID-only workflow input', () => {
  for (const workflowId of [
    'tender-stage2-requirements',
    'tender-stage3-evaluation',
  ]) {
    assert.deepEqual(materializeWorkflowPayload(workflowId, preflightWorkflowPayload(workflowId, {
      tender_id: tenderId,
      org_id: orgId,
      user_id: actorId,
      admission_id: admissionId,
    })), {
      workflowId,
      payload: { tender_id: tenderId, org_id: orgId },
    });
    assert.deepEqual(materializeWorkflowPayload(workflowId, preflightWorkflowPayload(workflowId, {
      body: { tender_id: tenderId, org_id: orgId, user_id: actorId, admission_id: admissionId },
    })), {
      workflowId,
      payload: { tender_id: tenderId, org_id: orgId },
    });
  }
});

test('Stage 3 carries only validated evidence for an explicit re-evaluation', () => {
  const requirementEvidence = [{
    requirement_id: 'REQ-001',
    status: 'verified',
    note: 'Freigabe liegt vor',
    cert_reference: null,
    cert_expiry: null,
    updated_at: '2026-08-05T20:00:00.000Z',
  }];
  const preflight = preflightWorkflowPayload('tender-stage3-evaluation', {
    tender_id: tenderId,
    org_id: orgId,
    user_id: actorId,
    admission_id: admissionId,
    evaluation_reason: 'evidence_changes',
    requirement_evidence: requirementEvidence,
  });

  assert.equal(preflight.trustedContext?.evaluation_reason, 'evidence_changes');
  assert.deepEqual(materializeWorkflowPayload('tender-stage3-evaluation', preflight), {
    workflowId: 'tender-stage3-evaluation',
    payload: { tender_id: tenderId, org_id: orgId, requirement_evidence: requirementEvidence },
  });
});

test('Stage 3 rejects malformed evidence before admission or state mutation', () => {
  const valid = {
    tender_id: tenderId,
    org_id: orgId,
    user_id: actorId,
    admission_id: admissionId,
    evaluation_reason: 'evidence_changes',
  };
  for (const requirement_evidence of [
    [{ requirement_id: 'REQ-001', status: 'verified' }],
    [{
      requirement_id: 'REQ-001',
      status: 'customer-controlled',
      note: null,
      cert_reference: null,
      cert_expiry: null,
      updated_at: '2026-08-05T20:00:00.000Z',
    }],
    Array.from({ length: 26 }, (_, index) => ({
      requirement_id: `REQ-${index}`,
      status: 'verified',
      note: null,
      cert_reference: null,
      cert_expiry: null,
      updated_at: '2026-08-05T20:00:00.000Z',
    })),
  ]) {
    assert.throws(
      () => preflightWorkflowPayload('tender-stage3-evaluation', {
        ...valid,
        requirement_evidence,
      }),
      /INVALID_WORKFLOW_PAYLOAD/,
    );
  }
});

test('configured preview organisation rejects other tenants before workflow work', () => {
  const payload = {
    tender_id: tenderId,
    org_id: orgId,
    user_id: actorId,
    admission_id: admissionId,
  };

  assert.equal(
    preflightWorkflowPayload('tender-stage2-requirements', payload, orgId).trustedContext?.org_id,
    orgId,
  );
  assert.throws(
    () => preflightWorkflowPayload('tender-stage2-requirements', payload, otherOrgId),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 503);
      assert.equal((error as { code?: string }).code, 'ADMISSION_UNAVAILABLE');
      return true;
    },
  );
  assert.throws(
    () => preflightWorkflowPayload('tender-stage2-requirements', payload, undefined, 'preview'),
    /ADMISSION_UNAVAILABLE/,
  );
});

test('Stage 1 keeps source data but recursively strips actor and lease fields', () => {
  for (const workflowId of ['tender-stage1-pdf', 'tender-stage1-gaeb']) {
    assert.deepEqual(materializeWorkflowPayload(workflowId, preflightWorkflowPayload(workflowId, {
      tender_id: tenderId,
      org_id: orgId,
      user_id: actorId,
      admission_id: admissionId,
      file_name: 'source.pdf',
      nested: {
        user_id: actorId,
        keep: 'safe',
        admission_id: admissionId,
        body: { legitimate: true },
      },
    })), {
      workflowId,
      payload: {
        tender_id: tenderId,
        org_id: orgId,
        file_name: 'source.pdf',
        nested: { keep: 'safe', body: { legitimate: true } },
      },
    });
  }
});

test('an unclaimable Stage 1 lease performs no business clone, telemetry, or workflow work', async () => {
  let businessReads = 0;
  let tableCalls = 0;
  let workflowLoads = 0;
  const payload: Record<string, unknown> = {
    tender_id: tenderId,
    org_id: orgId,
    user_id: actorId,
    admission_id: admissionId,
  };
  Object.defineProperty(payload, 'business', {
    enumerable: true,
    get() {
      businessReads += 1;
      throw new Error('business payload must not be cloned');
    },
  });
  const runner = new WorkflowRunner({
    async rpc() { return { data: false, error: null }; },
    from() { tableCalls += 1; throw new Error('telemetry must not run'); },
  } as never, () => {
    workflowLoads += 1;
    throw new Error('workflow must not load');
  });

  await assert.rejects(
    runner.run('tender-stage1-pdf', payload),
    /ADMISSION_UNAVAILABLE/,
  );
  assert.equal(businessReads, 0);
  assert.equal(tableCalls, 0);
  assert.equal(workflowLoads, 0);
});

test('claimed Stage 1 rejects hostile graphs before telemetry or workflow nodes', async () => {
  const cyclic: Record<string, unknown> = { value: 'safe' };
  cyclic.self = cyclic;
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let index = 0; index < 80; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  const dangerous = JSON.parse('{"constructor":{"polluted":true}}') as Record<string, unknown>;
  const large = { value: 'x'.repeat(80 * 1024 * 1024) };

  for (const hostile of [cyclic, deep, dangerous, large]) {
    let tableCalls = 0;
    let workflowLoads = 0;
    const runner = new WorkflowRunner({
      async rpc(name: string) {
        if (name === 'claim_pipeline_admission') return { data: true, error: null };
        assert.equal(name, 'claim_tender_processing_stage');
        return { data: [{ claimed: true, reason: null, processing_status: 'extracting_metadata' }], error: null };
      },
      from() { tableCalls += 1; throw new Error('telemetry must not run'); },
    } as never, () => {
      workflowLoads += 1;
      throw new Error('workflow must not load');
    });

    await assert.rejects(runner.run('tender-stage1-gaeb', {
      tender_id: tenderId,
      org_id: orgId,
      user_id: actorId,
      admission_id: admissionId,
      hostile,
    }));
    assert.equal(tableCalls, 0);
    assert.equal(workflowLoads, 0);
  }
});

test('only the top-level envelope body unwraps and legitimate nested body data survives', () => {
  const materialized = materializeWorkflowPayload('tender-stage1', preflightWorkflowPayload(
    'tender-stage1',
    {
      tender_id: tenderId,
      org_id: orgId,
      user_id: actorId,
      admission_id: admissionId,
      ignored_outer_business: true,
      body: {
        tender_id: tenderId,
        org_id: orgId,
        user_id: actorId,
        admission_id: admissionId,
        file_type: 'gaeb',
        nested: {
          body: { keep: 'legitimate' },
          user_id: actorId,
          admission_id: admissionId,
        },
      },
    },
  ));

  assert.equal(materialized.workflowId, 'tender-stage1-gaeb');
  assert.deepEqual(materialized.payload, {
    tender_id: tenderId,
    org_id: orgId,
    file_type: 'gaeb',
    nested: { body: { keep: 'legitimate' } },
  });
});

function recordingClient() {
  const inserts: Array<{ table: string; value: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; value: Record<string, unknown> }> = [];
  const rpcs: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const mutation = {
    eq() {
      return mutation;
    },
    async select() {
      return { data: [{}], error: null };
    },
  };

  return {
    inserts,
    updates,
    rpcs,
    client: {
      async rpc(name: string, parameters: Record<string, unknown>) {
        rpcs.push({ name, parameters });
        if (name === 'record_tender_processing_failure') {
          return {
            data: [{
              tender_id: parameters.p_tender_id,
              org_id: parameters.p_org_id,
              affected_count: 1,
              processing_attempt_count: 1,
            }],
            error: null,
          };
        }
        if (name === 'claim_tender_processing_stage') {
          return {
            data: [{
              claimed: true,
              reason: null,
              processing_status: parameters.p_processing_stage === 'stage1'
                ? 'extracting_metadata'
                : parameters.p_processing_stage === 'stage2' ? 'extracting_details' : 'evaluating',
            }],
            error: null,
          };
        }
        return { data: true, error: null };
      },
      from(table: string) {
        return {
          insert(value: Record<string, unknown>) {
            inserts.push({ table, value });
            return mutation;
          },
          update(value: Record<string, unknown>) {
            updates.push({ table, value });
            return mutation;
          },
        };
      },
    },
  };
}

test('Stage 1 defers its telemetry tender link until the workflow succeeds', async () => {
  for (const workflowId of ['tender-stage1-pdf', 'tender-stage1-gaeb']) {
    const database = recordingClient();
    const runner = new WorkflowRunner(database.client as never, passthroughWorkflow);

    const result = await runner.run(workflowId, {
      tender_id: tenderId,
      org_id: orgId,
      user_id: actorId,
      admission_id: admissionId,
    });

    assert.equal(result.status, 'done');
    const execution = database.inserts.find((entry) => entry.table === 'flow_executions');
    assert.equal(execution?.value.tender_id, null);
    const completion = database.updates.find((entry) => entry.table === 'flow_executions');
    assert.equal(completion?.value.tender_id, tenderId);
  }
});

test('failed Stage 1 records canonical durable failure after telemetry', async () => {
  const database = recordingClient();
  const runner = new WorkflowRunner(database.client as never, (workflowId) => ({
    id: workflowId,
    name: 'Fail before tender persistence',
    nodes: [{
      id: 'fail-before-save',
      name: 'Fail before save',
      type: 'unknown' as never,
      config: {},
    }],
    edges: [],
  }));

  const result = await runner.run('tender-stage1-pdf', {
    tender_id: tenderId,
    org_id: orgId,
    user_id: actorId,
    admission_id: admissionId,
  }, { correlationId: 'tenderly-upload-opaque' });

  assert.equal(result.status, 'error');
  const execution = database.inserts.find((entry) => entry.table === 'flow_executions');
  assert.equal(execution?.value.tender_id, null);
  const completion = database.updates.find((entry) => entry.table === 'flow_executions');
  assert.equal('tender_id' in (completion?.value ?? {}), false);
  assert.deepEqual(database.rpcs.at(-1), {
    name: 'record_tender_processing_failure',
    parameters: {
      p_tender_id: tenderId,
      p_org_id: orgId,
      p_processing_stage: 'stage1',
      p_processing_error_code: 'FLOW_STAGE_FAILED',
      p_processing_correlation_id: 'tenderly-upload-opaque',
    },
  });
});

function passthroughWorkflow(workflowId: string): WorkflowDefinition {
  return {
    id: workflowId,
    name: 'Tenant context capture',
    nodes: [{
      id: 'respond',
      name: 'Respond',
      type: 'respond',
      config: {},
    }],
    edges: [],
  };
}

test('valid Stage 2/3 forms record canonical IDs without exposing actor or lease to nodes', async () => {
  for (const workflowId of [
    'tender-stage2-requirements',
    'tender-stage3-evaluation',
  ]) {
    for (const payload of [
      { tender_id: tenderId, org_id: orgId, user_id: actorId, admission_id: admissionId, ignored: 'top-level-extra' },
      { body: { tender_id: tenderId, org_id: orgId, user_id: actorId, admission_id: admissionId, ignored: 'body-extra' } },
      {
        tender_id: tenderId.toUpperCase(),
        org_id: orgId.toUpperCase(),
        user_id: actorId.toUpperCase(),
        admission_id: admissionId.toUpperCase(),
        body: { tender_id: tenderId, org_id: orgId, user_id: actorId, admission_id: admissionId },
      },
    ]) {
      const database = recordingClient();
      const runner = new WorkflowRunner(database.client as never, passthroughWorkflow);
      const result = await runner.run(workflowId, payload);

      assert.equal(result.status, 'done');
      assert.deepEqual(result.response_payload, [{ json: {
        tender_id: tenderId,
        org_id: orgId,
      } }]);
      const execution = database.inserts.find((entry) => entry.table === 'flow_executions');
      assert.equal(execution?.value.tender_id, tenderId);
      assert.equal(execution?.value.correlation_id, execution?.value.id);
      assert.equal('actor_user_id' in (execution?.value ?? {}), false);
      assert.equal('org_id' in (execution?.value ?? {}), false);
    }
  }
});

test('missing, forged, or replayed leases stop every protected workflow before telemetry or nodes', async () => {
  for (const workflowId of [
    'tender-stage1-pdf',
    'tender-stage1-gaeb',
    'tender-stage2-requirements',
    'tender-stage3-evaluation',
  ]) {
    let rpcCalls = 0;
    let tableCalls = 0;
    let workflowLoads = 0;
    const runner = new WorkflowRunner({
      async rpc(name: string) {
        rpcCalls += 1;
        assert.equal(name, 'claim_pipeline_admission');
        return { data: false, error: null };
      },
      from() {
        tableCalls += 1;
        throw new Error('telemetry must not run');
      },
    } as never, () => {
      workflowLoads += 1;
      throw new Error('workflow must not load');
    });

    await assert.rejects(
      runner.run(workflowId, {
        tender_id: tenderId,
        org_id: orgId,
        user_id: actorId,
        admission_id: admissionId,
      }),
      /ADMISSION_UNAVAILABLE/,
    );
    assert.equal(rpcCalls, 1);
    assert.equal(tableCalls, 0);
    assert.equal(workflowLoads, 0);
  }
});

for (const failurePoint of ['initial', 'node', 'final'] as const) {
  test(`${failurePoint} telemetry failure records exactly one durable telemetry failure`, async () => {
    const failureCalls: Array<Record<string, unknown>> = [];
    const mutation = (table: string, kind: 'insert' | 'update') => {
      const value = {
        eq() { return value; },
        async select() {
          const shouldFail = failurePoint === 'initial'
            ? table === 'flow_executions' && kind === 'insert'
            : failurePoint === 'node'
              ? table === 'flow_node_runs' && kind === 'insert'
              : table === 'flow_executions' && kind === 'update';
          return shouldFail
            ? { data: null, error: { message: 'raw database and customer detail' } }
            : { data: [{}], error: null };
        },
      };
      return value;
    };
    const runner = new WorkflowRunner({
      async rpc(name: string, parameters: Record<string, unknown>) {
        if (name === 'claim_pipeline_admission') return { data: true, error: null };
        if (name === 'claim_tender_processing_stage') {
          return { data: [{ claimed: true, reason: null, processing_status: 'extracting_details' }], error: null };
        }
        if (name === 'record_tender_processing_failure') {
          failureCalls.push(parameters);
          return { data: [{
            tender_id: tenderId,
            org_id: orgId,
            affected_count: 1,
            processing_attempt_count: 1,
          }], error: null };
        }
        return { data: true, error: null };
      },
      from(table: string) {
        return {
          insert() { return mutation(table, 'insert'); },
          update() { return mutation(table, 'update'); },
        };
      },
    } as never, passthroughWorkflow);

    await assert.rejects(
      runner.run('tender-stage2-requirements', {
        tender_id: tenderId,
        org_id: orgId,
        user_id: actorId,
        admission_id: admissionId,
      }),
      (error: unknown) => error instanceof TelemetryPersistenceError
        && !String(error).includes('customer'),
    );
    assert.equal(failureCalls.length, 1);
    assert.equal(failureCalls[0].p_processing_stage, 'stage2');
    assert.equal(failureCalls[0].p_processing_error_code, 'FLOW_TELEMETRY_FAILED');
  });
}
