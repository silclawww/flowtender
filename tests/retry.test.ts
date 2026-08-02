import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildSafeRetry, SafeRetryError } from '../lib/retry.ts';

const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';

test('a failed stage-2 execution can be reconstructed from safe metadata', () => {
  const retry = buildSafeRetry({
    workflow_id: 'tender-stage2-requirements',
    tender_id: tenderId,
    status: 'error',
    correlation_id: 'req-123',
  });

  assert.deepEqual(retry, {
    workflowId: 'tender-stage2-requirements',
    triggerPayload: { tender_id: tenderId },
    correlationId: 'req-123',
  });
  assert.deepEqual(Object.keys(retry.triggerPayload), ['tender_id']);
});

test('successful executions cannot be retried', () => {
  assert.throws(
    () => buildSafeRetry({
      workflow_id: 'tender-stage2-requirements',
      tender_id: tenderId,
      status: 'done',
      correlation_id: null,
    }),
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
      workflow_id: 'tender-stage3-evaluation',
      tender_id: null,
      status: 'error',
      correlation_id: null,
    }),
    (error: unknown) => error instanceof SafeRetryError && error.code === 'EXECUTION_NOT_RETRYABLE',
  );
});

test('retry allows the same five-minute serverless window as initial processing', () => {
  const route = readFileSync(
    new URL('../app/api/flow/retry/[executionId]/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /export const maxDuration = 300;/);
});
