import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { handleRetryExecution } from '../lib/retry-handler.ts';
import { buildSafeRetry, SafeRetryError } from '../lib/retry.ts';
import { AdmissionControlError } from '../lib/admission-control.ts';

const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';
const orgId = '3edb0931-87a3-45a6-a8f1-c1e87d539596';
const actorId = 'fca2e00f-80ad-4c6c-afbb-392cf49eb7b6';
const rootExecutionId = 'ae2fbf60-d80a-4c5d-8b5c-24553b620e89';

const failedStage2 = {
  workflow_id: 'tender-stage2-requirements',
  tender_id: tenderId,
  status: 'error',
  correlation_id: rootExecutionId,
};

const actorContext = { actor_user_id: actorId, org_id: orgId };

test('a failed stage-2 execution can be reconstructed from safe metadata', () => {
  const retry = buildSafeRetry(failedStage2, orgId, actorContext);

  assert.deepEqual(retry, {
    workflowId: 'tender-stage2-requirements',
    triggerPayload: { tender_id: tenderId, org_id: orgId, user_id: actorId },
    correlationId: rootExecutionId,
    actorUserId: actorId,
    orgId,
    retryRootExecutionId: rootExecutionId,
  });
  assert.deepEqual(Object.keys(retry.triggerPayload), ['tender_id', 'org_id', 'user_id']);
});

test('successful executions cannot be retried', () => {
  assert.throws(
    () => buildSafeRetry({
      ...failedStage2,
      status: 'done',
    }, orgId, actorContext),
    (error: unknown) => error instanceof SafeRetryError && error.code === 'EXECUTION_NOT_RETRYABLE',
  );
});

test('stage-1 retry requires a fresh source upload', () => {
  assert.throws(
    () => buildSafeRetry({
      workflow_id: 'tender-stage1-pdf',
      tender_id: tenderId,
      status: 'error',
      correlation_id: null,
    }),
    (error: unknown) => error instanceof SafeRetryError && error.code === 'SOURCE_REUPLOAD_REQUIRED',
  );
});

test('retry fails closed without a tender identifier', () => {
  assert.throws(
    () => buildSafeRetry({
      ...failedStage2,
      workflow_id: 'tender-stage3-evaluation',
      tender_id: null,
    }, orgId, actorContext),
    (error: unknown) => error instanceof SafeRetryError && error.code === 'EXECUTION_NOT_RETRYABLE',
  );
});

test('retry fails closed without a valid immutable org context', () => {
  assert.throws(
    () => buildSafeRetry(failedStage2, 'customer-content-not-a-uuid', actorContext),
    (error: unknown) => {
      assert.equal(
        error instanceof SafeRetryError && error.code === 'RETRY_TENANT_CONTEXT_INVALID',
        true,
      );
      assert.doesNotMatch(String(error), /customer-content/);
      return true;
    },
  );
});

test('retry route reconstructs immutable tenant and actor identifiers under one root budget', async () => {
  let calledPayload: Record<string, unknown> | undefined;
  let admission: Record<string, unknown> | undefined;
  const released: string[] = [];
  const response = await handleRetryExecution('execution-id', {
    loadExecution: async () => ({ data: failedStage2, error: null }),
    loadRetryContext: async (rootId) => {
      assert.equal(rootId, rootExecutionId);
      return { data: actorContext, error: null };
    },
    loadTenderOrg: async (id) => {
      assert.equal(id, tenderId);
      return { data: { org_id: orgId }, error: null };
    },
    runWorkflow: async (_workflowId, payload, options) => {
      calledPayload = payload;
      assert.equal(options.retryRootExecutionId, rootExecutionId);
      return {
        execution_id: '6ca5d12d-4309-4a0e-b968-9cb7535c8fcb',
        status: 'done',
        duration_ms: 1,
      };
    },
    acquireAdmission: async (input) => {
      admission = input;
      return 'lease-a';
    },
    releaseAdmission: async (leaseId) => { released.push(leaseId); },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calledPayload, {
    tender_id: tenderId,
    org_id: orgId,
    user_id: actorId,
    admission_id: 'lease-a',
  });
  assert.deepEqual(admission, {
    actorUserId: actorId,
    orgId,
    operation: 'retry',
    retryRootExecutionId: rootExecutionId,
  });
  assert.deepEqual(released, ['lease-a']);
});

test('a failed retried workflow is never reported as a successful HTTP response', async () => {
  const response = await handleRetryExecution('execution-id', {
    loadExecution: async () => ({ data: failedStage2, error: null }),
    loadRetryContext: async () => ({ data: actorContext, error: null }),
    loadTenderOrg: async () => ({ data: { org_id: orgId }, error: null }),
    runWorkflow: async () => ({
      execution_id: '6ca5d12d-4309-4a0e-b968-9cb7535c8fcb',
      status: 'error',
      error_code: 'NODE_EXECUTION_FAILED',
      duration_ms: 1,
    }),
    acquireAdmission: async () => 'lease-a',
    releaseAdmission: async () => {},
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error_code: 'NODE_EXECUTION_FAILED',
    execution_id: '6ca5d12d-4309-4a0e-b968-9cb7535c8fcb',
  });
});

test('stage-1 retry rejection does not look up a tender', async () => {
  let tenderLookups = 0;
  const response = await handleRetryExecution('execution-id', {
    loadExecution: async () => ({
      data: { ...failedStage2, workflow_id: 'tender-stage1-pdf' },
      error: null,
    }),
    loadRetryContext: async () => { throw new Error('must not run'); },
    loadTenderOrg: async () => {
      tenderLookups += 1;
      throw new Error('must not run');
    },
    runWorkflow: async () => {
      throw new Error('must not run');
    },
    acquireAdmission: async () => { throw new Error('must not run'); },
    releaseAdmission: async () => { throw new Error('must not run'); },
  });

  assert.equal(response.status, 409);
  assert.equal(tenderLookups, 0);
  assert.deepEqual(await response.json(), { error_code: 'SOURCE_REUPLOAD_REQUIRED' });
});

test('retry route fails closed for missing, invalid, and unavailable org context', async () => {
  const cases = [
    {
      result: { data: null, error: { code: 'PGRST116', message: 'not found' } },
      status: 404,
      code: 'RETRY_TENDER_NOT_FOUND',
    },
    {
      result: { data: { org_id: null }, error: null },
      status: 409,
      code: 'RETRY_TENANT_CONTEXT_INVALID',
    },
    {
      result: { data: null, error: { code: '57P01', message: 'secret database host' } },
      status: 503,
      code: 'RETRY_CONTEXT_UNAVAILABLE',
    },
  ];

  for (const testCase of cases) {
    let workflowRuns = 0;
    const response = await handleRetryExecution('execution-id', {
      loadExecution: async () => ({ data: failedStage2, error: null }),
      loadRetryContext: async () => ({ data: actorContext, error: null }),
      loadTenderOrg: async () => testCase.result,
      runWorkflow: async () => {
        workflowRuns += 1;
        throw new Error('must not run');
      },
      acquireAdmission: async () => { throw new Error('must not run'); },
      releaseAdmission: async () => { throw new Error('must not run'); },
    });

    assert.equal(response.status, testCase.status);
    assert.equal(workflowRuns, 0);
    const body = await response.json();
    assert.deepEqual(body, { error_code: testCase.code });
    assert.doesNotMatch(JSON.stringify(body), /secret database host/);
  }
});

test('limiter denial and failure reject before workflow and release only acquired leases', async () => {
  for (const testCase of [
    { error: new AdmissionControlError(429, 'PIPELINE_LIMITED'), status: 429, code: 'PIPELINE_LIMITED' },
    { error: new AdmissionControlError(503, 'ADMISSION_UNAVAILABLE'), status: 503, code: 'ADMISSION_UNAVAILABLE' },
  ]) {
    let workflowRuns = 0;
    let releases = 0;
    const response = await handleRetryExecution('execution-id', {
      loadExecution: async () => ({ data: failedStage2, error: null }),
      loadRetryContext: async () => ({ data: actorContext, error: null }),
      loadTenderOrg: async () => ({ data: { org_id: orgId }, error: null }),
      acquireAdmission: async () => { throw testCase.error; },
      releaseAdmission: async () => { releases += 1; },
      runWorkflow: async () => {
        workflowRuns += 1;
        throw new Error('must not run');
      },
    });

    assert.equal(response.status, testCase.status);
    assert.deepEqual(await response.json(), { error_code: testCase.code });
    assert.equal(workflowRuns, 0);
    assert.equal(releases, 0);
  }
});

test('retry allows the same five-minute serverless window as initial processing', () => {
  const route = readFileSync(
    new URL('../app/api/flow/retry/[executionId]/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /export const maxDuration = 300;/);
});
