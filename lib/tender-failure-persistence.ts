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
    if (result.error != null
      || !row
      || typeof row !== 'object'
      || (row as { tender_id?: unknown }).tender_id !== input.tenderId
      || (row as { org_id?: unknown }).org_id !== input.orgId
      || (row as { affected_count?: unknown }).affected_count !== 1) {
      throw new TenderFailurePersistenceError();
    }
  } catch (error) {
    if (error instanceof TenderFailurePersistenceError) throw error;
    throw new TenderFailurePersistenceError();
  }
}
