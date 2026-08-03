import assert from 'node:assert/strict';
import test from 'node:test';

import { handleWebhookRequest } from '../lib/webhook-handler.ts';
import { TelemetryPersistenceError } from '../lib/telemetry-persistence.ts';
import { AdmissionControlError } from '../lib/admission-control.ts';

const SERVICE_KEY = 'service-secret-with-enough-entropy';
const OPERATOR_KEY = 'operator-secret-with-enough-entropy';
const TENDER_ID = '0b2f6f51-b91a-47db-b652-6a680a978efe';
const ORG_ID = '3edb0931-87a3-45a6-a8f1-c1e87d539596';
const USER_ID = 'fca2e00f-80ad-4c6c-afbb-392cf49eb7b6';
const ADMISSION_ID = 'c2b37af4-c299-4db7-859f-8423c3230d70';

function webhookRequest(token?: string): Request {
  return new Request('https://flowtender.example/api/flow/webhook/tender-details', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      tender_id: TENDER_ID,
      org_id: ORG_ID,
      user_id: USER_ID,
      admission_id: ADMISSION_ID,
    }),
  });
}

test('unauthenticated webhook requests never reach workflow processing', async () => {
  let calls = 0;
  const response = await handleWebhookRequest(
    webhookRequest(),
    'tender-details',
    async () => {
      calls += 1;
      throw new Error('must not run');
    },
    SERVICE_KEY,
    OPERATOR_KEY,
  );

  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('operator credentials cannot cross into the webhook boundary', async () => {
  let calls = 0;
  const response = await handleWebhookRequest(
    webhookRequest(OPERATOR_KEY),
    'tender-details',
    async () => {
      calls += 1;
      throw new Error('must not run');
    },
    SERVICE_KEY,
    OPERATOR_KEY,
  );

  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('the dedicated service credential reaches the expected processing workflow', async () => {
  let calledWorkflow: string | undefined;
  let calledPayload: Record<string, unknown> | undefined;
  const response = await handleWebhookRequest(
    webhookRequest(SERVICE_KEY),
    'tender-details',
    async (workflowId, payload) => {
      calledWorkflow = workflowId;
      calledPayload = payload;
      return {
        execution_id: '6ca5d12d-4309-4a0e-b968-9cb7535c8fcb',
        status: 'done',
        duration_ms: 2,
        response_payload: [{ json: { processing_status: 'details_ready' } }],
      };
    },
    SERVICE_KEY,
    OPERATOR_KEY,
  );

  assert.equal(response.status, 200);
  assert.equal(calledWorkflow, 'tender-stage2-requirements');
  assert.deepEqual(calledPayload, {
    tender_id: TENDER_ID,
    org_id: ORG_ID,
    user_id: USER_ID,
    admission_id: ADMISSION_ID,
  });
  assert.deepEqual(await response.json(), { processing_status: 'details_ready' });
});

test('Stage 1 format selection is deferred to the post-claim runner boundary', async () => {
  let calledWorkflow: string | undefined;
  const request = new Request('https://flowtender.example/api/flow/webhook/tender-metadata', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tender_id: TENDER_ID,
      org_id: ORG_ID,
      user_id: USER_ID,
      admission_id: ADMISSION_ID,
      file_type: 'gaeb',
      nested: { body: { legitimate: true } },
    }),
  });
  const response = await handleWebhookRequest(
    request,
    'tender-metadata',
    async (workflowId) => {
      calledWorkflow = workflowId;
      return {
        execution_id: '6ca5d12d-4309-4a0e-b968-9cb7535c8fcb',
        status: 'done',
        duration_ms: 1,
      };
    },
    SERVICE_KEY,
    OPERATOR_KEY,
  );

  assert.equal(response.status, 200);
  assert.equal(calledWorkflow, 'tender-stage1');
});

test('telemetry persistence failures return a redacted no-store service response', async () => {
  const response = await handleWebhookRequest(
    webhookRequest(SERVICE_KEY),
    'tender-details',
    async () => {
      throw new TelemetryPersistenceError();
    },
    SERVICE_KEY,
    OPERATOR_KEY,
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    error_code: 'TELEMETRY_PERSISTENCE_FAILED',
  });
});

test('missing or unclaimable admission state prevents workflow execution safely', async () => {
  const response = await handleWebhookRequest(
    webhookRequest(SERVICE_KEY),
    'tender-details',
    async () => { throw new AdmissionControlError(503, 'ADMISSION_UNAVAILABLE'); },
    SERVICE_KEY,
    OPERATOR_KEY,
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error_code: 'ADMISSION_UNAVAILABLE' });
});

test('service-authorised retries pass one validated immutable root to the runner', async () => {
  const root = '6ca5d12d-4309-4a0e-b968-9cb7535c8fcb';
  let options: unknown;
  const request = webhookRequest(SERVICE_KEY);
  const retryRequest = new Request(request, {
    headers: { ...Object.fromEntries(request.headers), 'X-Retry-Root-Execution-Id': root.toUpperCase() },
  });
  const response = await handleWebhookRequest(retryRequest, 'tender-details', async (_id, _payload, value) => {
    options = value;
    return { execution_id: root, status: 'done', duration_ms: 1 };
  }, SERVICE_KEY, OPERATOR_KEY);

  assert.equal(response.status, 200);
  assert.deepEqual(options, { synchronous: true, retryRootExecutionId: root });
});

test('malformed retry roots fail before runner work', async () => {
  let calls = 0;
  const request = webhookRequest(SERVICE_KEY);
  const retryRequest = new Request(request, {
    headers: { ...Object.fromEntries(request.headers), 'X-Retry-Root-Execution-Id': 'customer-content' },
  });
  const response = await handleWebhookRequest(retryRequest, 'tender-details', async () => {
    calls += 1;
    throw new Error('must not run');
  }, SERVICE_KEY, OPERATOR_KEY);
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  assert.deepEqual(await response.json(), { error_code: 'INVALID_RETRY_CONTEXT' });
});

test('invalid Stage 1/2 envelopes return one redacted admission error', async () => {
  for (const path of ['tender-metadata', 'tender-details']) {
    const request = new Request(`https://flowtender.example/api/flow/webhook/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const response = await handleWebhookRequest(
      request,
      path,
      async (workflowId, payload) => {
        const { WorkflowRunner } = await import('../lib/runner/runner.ts');
        return new WorkflowRunner({
          from() { throw new Error('database must not run'); },
        } as never, () => { throw new Error('workflow must not load'); })
          .run(workflowId, payload);
      },
      SERVICE_KEY,
      OPERATOR_KEY,
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error_code: 'ADMISSION_UNAVAILABLE' });
  }
});
