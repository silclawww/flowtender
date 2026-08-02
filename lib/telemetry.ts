export const TELEMETRY_TTL_DAYS = 7;

export type SafeErrorCode =
  | 'EXECUTION_FAILED'
  | 'EXECUTION_TIMED_OUT'
  | 'NODE_EXECUTION_FAILED'
  | 'UNKNOWN_NODE_TYPE'
  | 'WORKFLOW_LOAD_FAILED'
  | 'TELEMETRY_PERSISTENCE_FAILED';

type CompletionStatus = 'done' | 'error';

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW_STAGE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ERROR_CODES = new Set<SafeErrorCode>([
  'EXECUTION_FAILED',
  'EXECUTION_TIMED_OUT',
  'NODE_EXECUTION_FAILED',
  'UNKNOWN_NODE_TYPE',
  'WORKFLOW_LOAD_FAILED',
  'TELEMETRY_PERSISTENCE_FAILED',
]);

function requireWorkflowStage(value: string, field: 'workflow' | 'stage'): string {
  if (!WORKFLOW_STAGE_PATTERN.test(value)) {
    throw new Error(`Invalid telemetry ${field}`);
  }
  return value;
}

function normalizeTenderId(value: string | null | undefined): string | null {
  return value && UUID_PATTERN.test(value) ? value : null;
}

export function normalizeCorrelationId(
  candidate: string | null | undefined,
  fallback: string,
): string {
  if (candidate && OPAQUE_ID_PATTERN.test(candidate)) return candidate;
  if (OPAQUE_ID_PATTERN.test(fallback)) return fallback;
  throw new Error('Invalid telemetry correlation ID');
}

export function createExecutionTelemetry(input: {
  executionId: string;
  workflowId: string;
  tenderId?: string | null;
  correlationId: string;
  startedAt: string;
}) {
  return {
    id: input.executionId,
    workflow_id: requireWorkflowStage(input.workflowId, 'workflow'),
    tender_id: normalizeTenderId(input.tenderId),
    status: 'running' as const,
    started_at: input.startedAt,
    correlation_id: normalizeCorrelationId(input.correlationId, input.executionId),
  };
}

export function createNodeTelemetry(input: {
  executionId: string;
  stage: string;
  correlationId: string;
  startedAt: string;
}) {
  return {
    execution_id: input.executionId,
    stage: requireWorkflowStage(input.stage, 'stage'),
    status: 'running' as const,
    started_at: input.startedAt,
    correlation_id: normalizeCorrelationId(input.correlationId, input.executionId),
  };
}

function completionTelemetry(input: {
  status: CompletionStatus;
  safeErrorCode: SafeErrorCode | null;
  completedAt: string;
  durationMs: number;
}) {
  const safeErrorCode = input.status === 'done'
    ? null
    : SAFE_ERROR_CODES.has(input.safeErrorCode as SafeErrorCode)
      ? input.safeErrorCode
      : 'EXECUTION_FAILED';

  return {
    status: input.status,
    safe_error_code: safeErrorCode,
    completed_at: input.completedAt,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
  };
}

export const completeExecutionTelemetry = completionTelemetry;
export const completeNodeTelemetry = completionTelemetry;
