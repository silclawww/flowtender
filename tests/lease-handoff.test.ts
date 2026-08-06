import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkflowRunner } from '../lib/runner/runner.ts';
import type { WorkflowDefinition } from '../types/workflow.ts';

const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';
const orgId = '3edb0931-87a3-45a6-a8f1-c1e87d539596';
const actorId = 'fca2e00f-80ad-4c6c-afbb-392cf49eb7b6';
const leaseId = 'c2b37af4-c299-4db7-859f-8423c3230d70';

function workflow(id: string): WorkflowDefinition {
  return {
    id,
    name: 'Handoff probe',
    nodes: [{ id: 'respond', name: 'Respond', type: 'respond', config: {} }],
    edges: [],
  };
}

function database(claims: boolean[] = [true]) {
  const events: string[] = [];
  let claimIndex = 0;
  const mutation = {
    eq() { return mutation; },
    async select() {
      events.push('telemetry:select');
      return { data: [{}], error: null };
    },
  };
  return {
    events,
    client: {
      async rpc(name: string, parameters: Record<string, unknown>) {
        events.push(`rpc:${name}`);
        if (name === 'claim_pipeline_admission') {
          return { data: claims[claimIndex++] ?? false, error: null };
        }
        if (name === 'claim_tender_processing_stage') {
          const stage = parameters.p_processing_stage;
          return { data: [{
            claimed: true,
            reason: null,
            processing_status: stage === 'stage1'
              ? 'extracting_metadata'
              : stage === 'stage2' ? 'extracting_details' : 'evaluating',
          }], error: null };
        }
        return { data: true, error: null };
      },
      from(table: string) {
        events.push(`table:${table}`);
        return {
          insert() { return mutation; },
          update() { return mutation; },
        };
      },
    },
  };
}

function envelope(extra: Record<string, unknown> = {}) {
  return {
    tender_id: tenderId,
    org_id: orgId,
    user_id: actorId,
    admission_id: leaseId,
    ...extra,
  };
}

test('Stage 2/3 receiver claims before work and releases after every mutation', async () => {
  for (const workflowId of ['tender-stage2-requirements', 'tender-stage3-evaluation']) {
    const db = database();
    const runner = new WorkflowRunner(db.client as never, (id) => {
      db.events.push('workflow:load');
      return workflow(id);
    });

    const result = await runner.run(workflowId, envelope());

    assert.equal(result.status, 'done');
    assert.deepEqual(result.response_payload, [{ json: { tender_id: tenderId, org_id: orgId } }]);
    assert.equal(db.events[0], 'rpc:claim_pipeline_admission');
    assert.equal(db.events[1], 'rpc:claim_tender_processing_stage');
    assert.equal(db.events.at(-1), 'rpc:release_pipeline_admission');
    assert.ok(db.events.indexOf('workflow:load') < db.events.lastIndexOf('rpc:release_pipeline_admission'));
    assert.ok(db.events.lastIndexOf('telemetry:select') < db.events.lastIndexOf('rpc:release_pipeline_admission'));
  }
});

test('evidence re-evaluation uses the receiver one-winner claim before workflow work', async () => {
  const events: string[] = [];
  const telemetryMutation = {
    eq() { return telemetryMutation; },
    async select() { events.push('telemetry:select'); return { data: [{}], error: null }; },
  };
  const transition = {
    eq() { return transition; },
    async select() {
      events.push('reevaluation:claimed');
      return { data: [{ id: tenderId, processing_status: 'evaluating' }], error: null };
    },
  };
  const client = {
    async rpc(name: string) {
      events.push(`rpc:${name}`);
      if (name === 'claim_pipeline_admission') return { data: true, error: null };
      if (name === 'claim_tender_processing_stage') throw new Error('wrong Stage 3 claim');
      return { data: true, error: null };
    },
    from(table: string) {
      events.push(`table:${table}`);
      return {
        insert() { return telemetryMutation; },
        update() { return table === 'tenders' ? transition : telemetryMutation; },
      };
    },
  };
  const runner = new WorkflowRunner(client as never, (id) => {
    events.push('workflow:load');
    return workflow(id);
  });
  const requirementEvidence = [{
    requirement_id: 'REQ-001',
    status: 'verified',
    note: null,
    cert_reference: null,
    cert_expiry: null,
    updated_at: '2026-08-05T20:00:00.000Z',
  }];

  const result = await runner.run('tender-stage3-evaluation', envelope({
    evaluation_reason: 'evidence_changes',
    requirement_evidence: requirementEvidence,
  }));

  assert.equal(result.status, 'done');
  assert.deepEqual(result.response_payload, [{ json: {
    tender_id: tenderId,
    org_id: orgId,
    requirement_evidence: requirementEvidence,
  } }]);
  assert.equal(events[0], 'rpc:claim_pipeline_admission');
  assert.equal(events[1], 'table:tenders');
  assert.equal(events[2], 'reevaluation:claimed');
  assert.ok(events.indexOf('reevaluation:claimed') < events.indexOf('workflow:load'));
  assert.equal(events.includes('rpc:claim_tender_processing_stage'), false);
  assert.equal(events.at(-1), 'rpc:release_pipeline_admission');
});

test('Stage 1 claims before work but leaves the cross-service lease for Tenderly to finish', async () => {
  for (const workflowId of ['tender-stage1-pdf', 'tender-stage1-gaeb']) {
    const db = database();
    const runner = new WorkflowRunner(db.client as never, (id) => workflow(id));

    const result = await runner.run(workflowId, envelope({ file_name: 'source.pdf' }));

    assert.equal(result.status, 'done');
    assert.equal(db.events[0], 'rpc:claim_pipeline_admission');
    assert.equal(db.events[1], 'rpc:claim_tender_processing_stage');
    assert.equal(db.events.includes('rpc:release_pipeline_admission'), false);
    assert.deepEqual(result.response_payload, [{ json: {
      tender_id: tenderId,
      org_id: orgId,
      file_name: 'source.pdf',
    } }]);
  }
});

test('forged and replayed leases cause zero telemetry and zero workflow work', async () => {
  const db = database([true, false]);
  let loads = 0;
  const runner = new WorkflowRunner(db.client as never, (id) => {
    loads += 1;
    return workflow(id);
  });

  await runner.run('tender-stage2-requirements', envelope());
  const tablesAfterFirst = db.events.filter((event) => event.startsWith('table:')).length;
  const loadsAfterFirst = loads;

  await assert.rejects(
    runner.run('tender-stage2-requirements', envelope()),
    /ADMISSION_UNAVAILABLE/,
  );
  assert.equal(db.events.filter((event) => event.startsWith('table:')).length, tablesAfterFirst);
  assert.equal(loads, loadsAfterFirst);
  assert.equal(db.events.filter((event) => event === 'rpc:release_pipeline_admission').length, 1);
});

test('receiver releases Stage 2/3 and retry leases after telemetry persistence failure', async () => {
  for (const retryRootExecutionId of [undefined, 'ae2fbf60-d80a-4c5d-8b5c-24553b620e89']) {
    const events: string[] = [];
    const failureCalls: Array<Record<string, unknown>> = [];
    const mutation = {
      async select() {
        events.push('telemetry:failed');
        return { data: null, error: { message: 'database unavailable' } };
      },
    };
    const client = {
      async rpc(name: string, parameters: Record<string, unknown>) {
        events.push(`rpc:${name}`);
        if (name === 'record_tender_processing_failure') {
          failureCalls.push(parameters);
          return {
            data: [{
              tender_id: tenderId,
              org_id: orgId,
              affected_count: 1,
              processing_attempt_count: 1,
            }],
            error: null,
          };
        }
        if (name === 'claim_tender_processing_stage') {
          return { data: [{ claimed: true, reason: null, processing_status: 'extracting_details' }], error: null };
        }
        return { data: true, error: null };
      },
      from(table: string) {
        events.push(`table:${table}`);
        return { insert() { return mutation; } };
      },
    };
    const runner = new WorkflowRunner(client as never, (id) => workflow(id));

    await assert.rejects(
      runner.run('tender-stage2-requirements', envelope(), { retryRootExecutionId }),
      (error: unknown) => (error as { code?: string }).code === 'TELEMETRY_PERSISTENCE_FAILED',
    );
    assert.equal(events[0], 'rpc:claim_pipeline_admission');
    assert.equal(events.at(-1), 'rpc:release_pipeline_admission');
    assert.equal(failureCalls.length, 1);
    assert.deepEqual(failureCalls[0], {
      p_tender_id: tenderId,
      p_org_id: orgId,
      p_processing_stage: 'stage2',
      p_processing_error_code: 'FLOW_TELEMETRY_FAILED',
      p_processing_correlation_id: retryRootExecutionId
        ?? failureCalls[0].p_processing_correlation_id,
    });
    assert.match(String(failureCalls[0].p_processing_correlation_id), /^[A-Za-z0-9._:-]{1,128}$/);
    assert.ok(events.indexOf('rpc:record_tender_processing_failure')
      < events.indexOf('rpc:release_pipeline_admission'));
  }
});
