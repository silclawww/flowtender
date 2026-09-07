import type { AdmissionOperation } from './tenant-context.ts';
import type { SafeErrorCode } from './telemetry.ts';

export type ProcessingStage = 'stage1' | 'stage2' | 'stage3';

type ProcessingErrorCode =
  | 'FLOW_STAGE_FAILED'
  | 'FLOW_STAGE_TIMEOUT'
  | 'FLOW_TELEMETRY_FAILED';

export const TENDER_FAILURE_PERSISTENCE_ERROR_CODE = 'TENDER_FAILURE_PERSISTENCE_FAILED' as const;

export class TenderFailurePersistenceError extends Error {
  readonly code = TENDER_FAILURE_PERSISTENCE_ERROR_CODE;

  constructor() {
    super('Tender failure persistence failed');
    this.name = 'TenderFailurePersistenceError';
  }
}

export class TenderStageTransitionError extends Error {
  readonly status = 409;
  readonly code = 'PIPELINE_STATE_CONFLICT' as const;

  constructor() {
    super('PIPELINE_STATE_CONFLICT');
    this.name = 'TenderStageTransitionError';
  }
}

export class TenderStagePersistenceError extends Error {
  readonly status = 503;
  readonly code = 'PIPELINE_STATE_UNAVAILABLE' as const;

  constructor() {
    super('PIPELINE_STATE_UNAVAILABLE');
    this.name = 'TenderStagePersistenceError';
  }
}

export function canonicalProcessingStage(operation: AdmissionOperation): ProcessingStage {
  if (operation === 'upload') return 'stage1';
  return operation;
}

function processingErrorCode(errorCode: SafeErrorCode): ProcessingErrorCode {
  if (errorCode === 'EXECUTION_TIMED_OUT') return 'FLOW_STAGE_TIMEOUT';
  if (errorCode === 'TELEMETRY_PERSISTENCE_FAILED') return 'FLOW_TELEMETRY_FAILED';
  return 'FLOW_STAGE_FAILED';
}

interface FailureRpcClient {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: unknown;
  }>;
}

interface ReevaluationClaimQuery {
  eq(column: string, value: unknown): ReevaluationClaimQuery;
  select(columns: string): PromiseLike<{ data: unknown; error: unknown }>;
}

interface ReevaluationClaimClient {
  from(name: string): {
    update(values: Record<string, unknown>): ReevaluationClaimQuery;
  };
}

export async function claimTenderEvidenceReevaluation(
  client: ReevaluationClaimClient,
  input: { tenderId: string; orgId: string; startedAt?: string },
): Promise<void> {
  try {
    const result = await client.from('tenders').update({
      processing_status: 'evaluating',
      processing_stage: 'stage3',
      processing_started_at: input.startedAt ?? new Date().toISOString(),
      processing_error_code: null,
      processing_error_at: null,
      processing_correlation_id: null,
    })
      .eq('id', input.tenderId)
      .eq('org_id', input.orgId)
      .eq('processing_status', 'complete')
      .select('id,processing_status');
    if (result.error != null) throw new TenderStagePersistenceError();
    if (Array.isArray(result.data) && result.data.length === 0) {
      throw new TenderStageTransitionError();
    }
    const row = Array.isArray(result.data) && result.data.length === 1
      ? result.data[0] : null;
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'id,processing_status') {
      throw new TenderStagePersistenceError();
    }
    const record = row as Record<string, unknown>;
    if (record.id !== input.tenderId || record.processing_status !== 'evaluating') {
      throw new TenderStagePersistenceError();
    }
  } catch (error) {
    if (error instanceof TenderStageTransitionError || error instanceof TenderStagePersistenceError) throw error;
    throw new TenderStagePersistenceError();
  }
}

export async function claimTenderProcessingStage(
  client: FailureRpcClient,
  input: {
    tenderId: string;
    orgId: string;
    stage: ProcessingStage;
    isRetry: boolean;
  },
): Promise<void> {
  try {
    const result = await client.rpc('claim_tender_processing_stage', {
      p_tender_id: input.tenderId,
      p_org_id: input.orgId,
      p_processing_stage: input.stage,
      p_is_retry: input.isRetry,
    });
    const row = Array.isArray(result.data) && result.data.length === 1
      ? result.data[0]
      : null;
    if (result.error != null || !row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'claimed,processing_status,reason') {
      throw new TenderStagePersistenceError();
    }
    const record = row as Record<string, unknown>;
    const expected = input.stage === 'stage1'
      ? 'extracting_metadata'
      : input.stage === 'stage2' ? 'extracting_details' : 'evaluating';
    if (record.claimed === true && record.reason === null && record.processing_status === expected) return;
    if (record.claimed === false
      && ['already_in_flight', 'already_complete', 'invalid_transition', 'not_found'].includes(String(record.reason))
      && (record.processing_status === null || typeof record.processing_status === 'string')) {
      throw new TenderStageTransitionError();
    }
    throw new TenderStagePersistenceError();
  } catch (error) {
    if (error instanceof TenderStageTransitionError || error instanceof TenderStagePersistenceError) throw error;
    throw new TenderStagePersistenceError();
  }
}

/**
 * Persist a redacted terminal tender state. Provider errors and row contents
 * never cross this boundary, and a missing/ambiguous dual-ID target fails shut.
 */
export async function persistTenderFailure(
  client: FailureRpcClient,
  input: {
    tenderId: string;
    orgId: string;
    stage: ProcessingStage;
    safeErrorCode: SafeErrorCode;
    correlationId: string;
  },
): Promise<void> {
  try {
    const result = await client.rpc('record_tender_processing_failure', {
      p_tender_id: input.tenderId,
      p_org_id: input.orgId,
      p_processing_stage: input.stage,
      p_processing_error_code: processingErrorCode(input.safeErrorCode),
      p_processing_correlation_id: input.correlationId,
    });
    const row = Array.isArray(result.data) && result.data.length === 1
      ? result.data[0]
      : null;
    const rowKeys = row && typeof row === 'object'
      ? Object.keys(row).sort()
      : [];
    if (result.error != null
      || !row
      || typeof row !== 'object'
      || rowKeys.join(',') !== 'affected_count,org_id,processing_attempt_count,tender_id'
      || (row as { tender_id?: unknown }).tender_id !== input.tenderId
      || (row as { org_id?: unknown }).org_id !== input.orgId
      || (row as { affected_count?: unknown }).affected_count !== 1
      || !Number.isSafeInteger((row as { processing_attempt_count?: unknown }).processing_attempt_count)
      || Number((row as { processing_attempt_count?: unknown }).processing_attempt_count) <= 0) {
      throw new TenderFailurePersistenceError();
    }
  } catch (error) {
    if (error instanceof TenderFailurePersistenceError) throw error;
    throw new TenderFailurePersistenceError();
  }
}
