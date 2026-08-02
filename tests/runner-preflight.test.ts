import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkflowRunner } from '../lib/runner/runner.ts';
import { preflightWorkflowPayload } from '../lib/tenant-context.ts';
import { TelemetryPersistenceError } from '../lib/telemetry-persistence.ts';
import type { WorkflowDefinition } from '../types/workflow.ts';

const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';
const orgId = '3edb0931-87a3-45a6-a8f1-c1e87d539596';
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
  'tender-stage2-requirements',
  'tender-stage3-evaluation',
]) {
  test(`${workflowId} rejects invalid tenant context before DB or workflow loading`, async () => {
    for (const payload of [
      null,
      [],
      {},
      { tender_id: tenderId },
      { org_id: orgId },
      { tender_id: 'customer-content-not-a-uuid', org_id: orgId },
      { body: { tender_id: tenderId, org_id: 'customer-content-not-a-uuid' } },
      {
        tender_id: tenderId,
        org_id: orgId,
        body: { tender_id: otherTenderId, org_id: orgId },
      },
      {
        tender_id: tenderId,
        org_id: orgId,
        body: { tender_id: tenderId, org_id: otherOrgId },
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
          assert.equal(String(error), 'Error: INVALID_TENANT_CONTEXT');
          assert.doesNotMatch(String(error), /customer-content/);
          return true;
        },
      );
      assert.equal(database.calls, 0);
      assert.equal(workflowLoads, 0);
    }
  });
}

test('valid direct and wrapped Stage 2/3 tenant contexts pass preflight', () => {
  for (const workflowId of [
    'tender-stage2-requirements',
    'tender-stage3-evaluation',
  ]) {
    assert.deepEqual(preflightWorkflowPayload(workflowId, {
      tender_id: tenderId,
      org_id: orgId,
    }), {
      payload: { tender_id: tenderId, org_id: orgId },
      tenantContext: { tender_id: tenderId, org_id: orgId },
    });
    assert.deepEqual(preflightWorkflowPayload(workflowId, {
      body: { tender_id: tenderId, org_id: orgId },
    }), {
      payload: { tender_id: tenderId, org_id: orgId },
      tenantContext: { tender_id: tenderId, org_id: orgId },
    });
  }
});

function recordingClient() {
  const inserts: Array<{ table: string; value: Record<string, unknown> }> = [];
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
    client: {
      from(table: string) {
        return {
          insert(value: Record<string, unknown>) {
            inserts.push({ table, value });
            return mutation;
          },
          update() {
            return mutation;
          },
        };
      },
    },
  };
}

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

test('valid Stage 2/3 forms record and process the same canonical identifiers', async () => {
  for (const workflowId of [
    'tender-stage2-requirements',
    'tender-stage3-evaluation',
  ]) {
    for (const payload of [
      { tender_id: tenderId, org_id: orgId, ignored: 'top-level-extra' },
      { body: { tender_id: tenderId, org_id: orgId, ignored: 'body-extra' } },
      {
        tender_id: tenderId.toUpperCase(),
        org_id: orgId.toUpperCase(),
        body: { tender_id: tenderId, org_id: orgId },
      },
    ]) {
      const database = recordingClient();
      const runner = new WorkflowRunner(database.client as never, passthroughWorkflow);
      const result = await runner.run(workflowId, payload);

      assert.equal(result.status, 'done');
      assert.deepEqual(result.response_payload, [{ json: { tender_id: tenderId, org_id: orgId } }]);
      const execution = database.inserts.find((entry) => entry.table === 'flow_executions');
      assert.equal(execution?.value.tender_id, tenderId);
    }
  }
});

test('Stage 1 remains outside the tenant-context preflight', async () => {
  const payload = { source_filename: 'source.pdf' };
  assert.deepEqual(preflightWorkflowPayload('tender-stage1-pdf', payload), {
    payload,
    tenantContext: null,
  });
  assert.deepEqual(preflightWorkflowPayload('tender-stage1-gaeb', payload), {
    payload,
    tenantContext: null,
  });

  const database = rejectingClient();
  const runner = new WorkflowRunner(database.client as never);
  await assert.rejects(
    () => runner.run('tender-stage1-pdf', {}),
    TelemetryPersistenceError,
  );
  assert.equal(database.calls, 1);
});
