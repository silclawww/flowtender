import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TELEMETRY_TTL_DAYS,
  completeExecutionTelemetry,
  completeNodeTelemetry,
  createExecutionTelemetry,
  createNodeTelemetry,
  normalizeCorrelationId,
} from '../lib/telemetry.ts';

const startedAt = '2026-08-02T10:00:00.000Z';
const completedAt = '2026-08-02T10:00:02.000Z';
const executionId = '6ca5d12d-4309-4a0e-b968-9cb7535c8fcb';
const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

test('execution telemetry contains only the approved start fields', () => {
  const telemetry = createExecutionTelemetry({
    executionId,
    workflowId: 'tender-stage2-requirements',
    tenderId,
    correlationId: 'tenderly-req-123',
    startedAt,
  });

  assert.deepEqual(sortedKeys(telemetry), [
    'correlation_id',
    'id',
    'started_at',
    'status',
    'tender_id',
    'workflow_id',
  ]);
});

test('node telemetry contains stage metadata but no node payload', () => {
  const telemetry = createNodeTelemetry({
    executionId,
    stage: 'extract-requirements-llm',
    correlationId: 'tenderly-req-123',
    startedAt,
  });

  assert.deepEqual(sortedKeys(telemetry), [
    'correlation_id',
    'execution_id',
    'stage',
    'started_at',
    'status',
  ]);
});

test('completion telemetry stores a fixed error code, never the raw error', () => {
  const rawSecret = 'prompt and company_profile plus full AI response';
  const execution = completeExecutionTelemetry({
    status: 'error',
    safeErrorCode: 'NODE_EXECUTION_FAILED',
    completedAt,
    durationMs: 2000,
  });
  const node = completeNodeTelemetry({
    status: 'error',
    safeErrorCode: 'NODE_EXECUTION_FAILED',
    completedAt,
    durationMs: 400,
  });

  assert.deepEqual(sortedKeys(execution), [
    'completed_at',
    'duration_ms',
    'safe_error_code',
    'status',
  ]);
  assert.deepEqual(sortedKeys(node), sortedKeys(execution));
  assert.equal(JSON.stringify({ execution, node }).includes(rawSecret), false);
  assert.equal('error' in execution, false);
  assert.equal('input' in node, false);
  assert.equal('output' in node, false);

  const hostile = completeExecutionTelemetry({
    status: 'error',
    safeErrorCode: rawSecret as never,
    completedAt,
    durationMs: 1,
  });
  assert.equal(hostile.safe_error_code, 'EXECUTION_FAILED');
  assert.equal(JSON.stringify(hostile).includes(rawSecret), false);
});

test('correlation IDs are restricted to short opaque identifiers', () => {
  assert.equal(normalizeCorrelationId('req_ABC-123.4', 'fallback-id'), 'req_ABC-123.4');
  assert.equal(normalizeCorrelationId('contains spaces and prompt text', 'fallback-id'), 'fallback-id');
  assert.equal(normalizeCorrelationId('x'.repeat(129), 'fallback-id'), 'fallback-id');

  const hostile = createExecutionTelemetry({
    executionId,
    workflowId: 'tender-stage2-requirements',
    tenderId,
    correlationId: 'prompt and raw document text',
    startedAt,
  });
  assert.equal(hostile.correlation_id, executionId);
});

test('redacted telemetry has a documented seven-day TTL', () => {
  assert.equal(TELEMETRY_TTL_DAYS, 7);
});
