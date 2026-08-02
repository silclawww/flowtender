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
