import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalProcessingStage,
  persistTenderFailure,
  TenderFailurePersistenceError,
} from '../lib/tender-failure-persistence.ts';

const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';
const orgId = '3edb0931-87a3-45a6-a8f1-c1e87d539596';

test('trusted operations map to canonical stages', () => {
  assert.equal(canonicalProcessingStage('upload'), 'stage1');
  assert.equal(canonicalProcessingStage('stage2'), 'stage2');
  assert.equal(canonicalProcessingStage('stage3'), 'stage3');
});

test('failure RPC receives only exact redacted metadata', async () => {
  let call: { name: string; parameters: Record<string, unknown> } | undefined;
  await persistTenderFailure({
    async rpc(name, parameters) {
      call = { name, parameters };
      return {
        data: [{ tender_id: tenderId, org_id: orgId, affected_count: 1, processing_attempt_count: 4 }],
        error: null,
      };
    },
  }, {
    tenderId,
    orgId,
    stage: 'stage2',
    safeErrorCode: 'NODE_EXECUTION_FAILED',
    correlationId: 'opaque-request-123',
  });

  assert.deepEqual(call, {
    name: 'record_tender_processing_failure',
    parameters: {
      p_tender_id: tenderId,
      p_org_id: orgId,
      p_processing_stage: 'stage2',
      p_processing_error_code: 'FLOW_STAGE_FAILED',
      p_processing_correlation_id: 'opaque-request-123',
    },
  });
  assert.equal(JSON.stringify(call).includes('raw'), false);
});

test('timeout uses a fixed safe code', async () => {
  let parameters: Record<string, unknown> = {};
  await persistTenderFailure({
    async rpc(_name, value) {
      parameters = value;
      return { data: [{ tender_id: tenderId, org_id: orgId, affected_count: 1 }], error: null };
    },
  }, {
    tenderId,
    orgId,
    stage: 'stage3',
    safeErrorCode: 'EXECUTION_TIMED_OUT',
    correlationId: 'opaque-timeout',
  });
  assert.equal(parameters.p_processing_error_code, 'FLOW_STAGE_TIMEOUT');
});

for (const result of [
  { data: [], error: null },
  { data: [{ tender_id: tenderId, org_id: orgId, affected_count: 0 }], error: null },
  { data: [{ tender_id: tenderId, org_id: 'wrong', affected_count: 1 }], error: null },
  { data: null, error: { message: 'raw database hostname and customer data' } },
]) {
  test('zero-row, mismatched, and database failures fail closed without leakage', async () => {
    await assert.rejects(
      () => persistTenderFailure({ async rpc() { return result; } }, {
        tenderId,
        orgId,
        stage: 'stage1',
        safeErrorCode: 'EXECUTION_FAILED',
        correlationId: 'opaque-failure',
      }),
      (error: unknown) => {
        assert.ok(error instanceof TenderFailurePersistenceError);
        assert.equal(error.code, 'TENDER_FAILURE_PERSISTENCE_FAILED');
        assert.doesNotMatch(String(error), /hostname|customer/);
        return true;
      },
    );
  });
}
