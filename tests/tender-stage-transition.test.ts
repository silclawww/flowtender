import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimTenderEvidenceReevaluation,
  claimTenderProcessingStage,
  TenderStagePersistenceError,
  TenderStageTransitionError,
} from '../lib/tender-failure-persistence.ts';

const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';
const orgId = '3edb0931-87a3-45a6-a8f1-c1e87d539596';

test('each stage claim forwards exact dual-ID transition input', async () => {
  for (const [stage, processingStatus] of [
    ['stage1', 'extracting_metadata'],
    ['stage2', 'extracting_details'],
    ['stage3', 'evaluating'],
  ] as const) {
    let call: unknown;
    await claimTenderProcessingStage({ async rpc(name, parameters) {
      call = { name, parameters };
      return { data: [{ claimed: true, reason: null, processing_status: processingStatus }], error: null };
    } }, { tenderId, orgId, stage, isRetry: stage === 'stage3' });
    assert.deepEqual(call, {
      name: 'claim_tender_processing_stage',
      parameters: {
        p_tender_id: tenderId,
        p_org_id: orgId,
        p_processing_stage: stage,
        p_is_retry: stage === 'stage3',
      },
    });
  }
});

test('evidence re-evaluation atomically claims one completed tender', async () => {
  const call: Record<string, unknown> = {};
  const filters: Array<[string, unknown]> = [];
  const builder = {
    eq(column: string, value: unknown) { filters.push([column, value]); return this; },
    async select(columns: string) {
      call.select = columns;
      return { data: [{ id: tenderId, processing_status: 'evaluating' }], error: null };
    },
  };

  await claimTenderEvidenceReevaluation({
    from(table: string) {
      call.table = table;
      return {
        update(values: Record<string, unknown>) { call.update = values; return builder; },
      };
    },
  }, { tenderId, orgId, startedAt: '2026-08-05T20:02:00.000Z' });

  assert.deepEqual(call, {
    table: 'tenders',
    update: {
      processing_status: 'evaluating',
      processing_stage: 'stage3',
      processing_started_at: '2026-08-05T20:02:00.000Z',
      processing_error_code: null,
      processing_error_at: null,
      processing_correlation_id: null,
    },
    select: 'id,processing_status',
  });
  assert.deepEqual(filters, [
    ['id', tenderId],
    ['org_id', orgId],
    ['processing_status', 'complete'],
  ]);
});

test('lost and malformed re-evaluation claims fail before paid work', async () => {
  for (const [result, ErrorType] of [
    [{ data: [], error: null }, TenderStageTransitionError],
    [{ data: null, error: { message: 'secret database detail' } }, TenderStagePersistenceError],
  ] as const) {
    const builder = {
      eq() { return this; },
      async select() { return result; },
    };
    await assert.rejects(
      claimTenderEvidenceReevaluation({
        from() { return { update() { return builder; } }; },
      }, { tenderId, orgId, startedAt: '2026-08-05T20:02:00.000Z' }),
      (error: unknown) => error instanceof ErrorType && !String(error).includes('secret'),
    );
  }
});

test('duplicate and invalid transitions fail before paid work with one safe conflict', async () => {
  for (const reason of ['already_in_flight', 'already_complete', 'invalid_transition', 'not_found']) {
    await assert.rejects(
      claimTenderProcessingStage({ async rpc() {
        return { data: [{ claimed: false, reason, processing_status: 'extracting_details' }], error: null };
      } }, { tenderId, orgId, stage: 'stage2', isRetry: false }),
      (error: unknown) => error instanceof TenderStageTransitionError
        && error.code === 'PIPELINE_STATE_CONFLICT',
    );
  }
});

test('malformed or failed transition RPCs fail closed as unavailable', async () => {
  for (const result of [
    { data: null, error: null },
    { data: [], error: null },
    { data: [{ claimed: true, reason: null, processing_status: 'complete' }], error: null },
    { data: [{ claimed: false, reason: 'raw-provider-detail', processing_status: null }], error: null },
    { data: null, error: { message: 'secret database detail' } },
  ]) {
    await assert.rejects(
      claimTenderProcessingStage({ async rpc() { return result; } }, {
        tenderId, orgId, stage: 'stage2', isRetry: false,
      }),
      (error: unknown) => error instanceof TenderStagePersistenceError
        && !String(error).includes('secret'),
    );
  }
});
