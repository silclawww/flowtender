import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkflowRunner } from '../lib/runner/runner.ts';
import { requireWorkflowTenantContext } from '../lib/tenant-context.ts';
import { TelemetryPersistenceError } from '../lib/telemetry-persistence.ts';

const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';
const orgId = '3edb0931-87a3-45a6-a8f1-c1e87d539596';

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
    assert.doesNotThrow(() => requireWorkflowTenantContext(workflowId, {
      tender_id: tenderId,
      org_id: orgId,
    }));
    assert.doesNotThrow(() => requireWorkflowTenantContext(workflowId, {
      body: { tender_id: tenderId, org_id: orgId },
    }));
  }
});

test('Stage 1 remains outside the tenant-context preflight', async () => {
  assert.doesNotThrow(() => requireWorkflowTenantContext('tender-stage1-pdf', {}));
  assert.doesNotThrow(() => requireWorkflowTenantContext('tender-stage1-gaeb', {}));

  const database = rejectingClient();
  const runner = new WorkflowRunner(database.client as never);
  await assert.rejects(
    () => runner.run('tender-stage1-pdf', {}),
    TelemetryPersistenceError,
  );
  assert.equal(database.calls, 1);
});
