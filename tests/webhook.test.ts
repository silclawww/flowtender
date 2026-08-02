import assert from 'node:assert/strict';
import test from 'node:test';

import { handleWebhookRequest } from '../lib/webhook-handler.ts';
import { TelemetryPersistenceError } from '../lib/telemetry-persistence.ts';

const SERVICE_KEY = 'service-secret-with-enough-entropy';
const OPERATOR_KEY = 'operator-secret-with-enough-entropy';

function webhookRequest(token?: string): Request {
  return new Request('https://flowtender.example/api/flow/webhook/tender-details', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ tender_id: '0b2f6f51-b91a-47db-b652-6a680a978efe' }),
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
  assert.equal(calledPayload?.tender_id, '0b2f6f51-b91a-47db-b652-6a680a978efe');
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
