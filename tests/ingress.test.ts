import assert from 'node:assert/strict';
import test from 'node:test';

import { FLOW_INGRESS_MAX_BYTES } from '../lib/ingress.ts';
import { handleTriggerRequest } from '../lib/trigger-handler.ts';
import { handleWebhookRequest } from '../lib/webhook-handler.ts';

const serviceKey = 'service-secret-with-enough-entropy';

function request(body: BodyInit, headers: Record<string, string> = {}): Request {
  const init: RequestInit & { duplex?: 'half' } = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
      ...headers,
    },
    body,
  };
  if (body instanceof ReadableStream) init.duplex = 'half';
  return new Request('https://flowtender.example/api/flow/trigger/workflow', init);
}

const successfulRun = async () => ({
  execution_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  status: 'done' as const,
  duration_ms: 1,
});

test('production ingress default matches the outbound JSON contract', () => {
  assert.equal(FLOW_INGRESS_MAX_BYTES, 4_250_000);
  assert.ok(FLOW_INGRESS_MAX_BYTES < 4_500_000);
});

test('declared oversized webhook and trigger requests fail before body parsing or workflow work', async () => {
  for (const invoke of [
    (incoming: Request, run: typeof successfulRun) => handleWebhookRequest(
      incoming,
      'tender-details',
      run,
      serviceKey,
      'operator-secret-with-enough-entropy',
      32,
    ),
    (incoming: Request, run: typeof successfulRun) => handleTriggerRequest(
      incoming,
      'tender-stage2-requirements',
      run,
      serviceKey,
      'operator-secret-with-enough-entropy',
      32,
    ),
  ]) {
    let runs = 0;
    const response = await invoke(
      request('{}', { 'content-length': '999' }),
      async () => { runs += 1; return successfulRun(); },
    );
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error_code: 'PAYLOAD_TOO_LARGE' });
    assert.equal(runs, 0);
  }
});

test('chunked ingress stops at the byte ceiling before workflow work', async () => {
  for (const invoke of [
    (incoming: Request, run: typeof successfulRun) => handleWebhookRequest(
      incoming,
      'tender-details',
      run,
      serviceKey,
      'operator-secret-with-enough-entropy',
      16,
    ),
    (incoming: Request, run: typeof successfulRun) => handleTriggerRequest(
      incoming,
      'tender-stage2-requirements',
      run,
      serviceKey,
      'operator-secret-with-enough-entropy',
      16,
    ),
  ]) {
    let runs = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"payload":"'));
        controller.enqueue(new TextEncoder().encode('customer-content-too-large"}'));
      },
      cancel() { cancelled = true; },
    });
    const response = await invoke(
      request(stream),
      async () => { runs += 1; return successfulRun(); },
    );
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error_code: 'PAYLOAD_TOO_LARGE' });
    assert.equal(runs, 0);
    assert.equal(cancelled, true);
  }
});

test('malformed JSON is rejected consistently instead of becoming an empty workflow payload', async () => {
  for (const invoke of [
    (incoming: Request, run: typeof successfulRun) => handleWebhookRequest(
      incoming,
      'tender-details',
      run,
      serviceKey,
      'operator-secret-with-enough-entropy',
      128,
    ),
    (incoming: Request, run: typeof successfulRun) => handleTriggerRequest(
      incoming,
      'tender-stage2-requirements',
      run,
      serviceKey,
      'operator-secret-with-enough-entropy',
      128,
    ),
  ]) {
    let runs = 0;
    const response = await invoke(
      request('{malformed-json'),
      async () => { runs += 1; return successfulRun(); },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error_code: 'INVALID_JSON' });
    assert.equal(runs, 0);
  }
});
