export type SafeRetryErrorCode =
  | 'EXECUTION_NOT_RETRYABLE'
  | 'SOURCE_REUPLOAD_REQUIRED';

export class SafeRetryError extends Error {
  readonly code: SafeRetryErrorCode;

  constructor(
    code: SafeRetryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SafeRetryError';
    this.code = code;
  }
}

interface RetryableExecution {
  workflow_id: string;
  tender_id: string | null;
  status: string;
  correlation_id: string | null;
}

const RECONSTRUCTABLE_WORKFLOWS = new Set([
  'tender-stage2-requirements',
  'tender-stage3-evaluation',
]);

const SOURCE_WORKFLOWS = new Set([
  'tender-stage1-gaeb',
  'tender-stage1-pdf',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Build the only retry payload that can be reconstructed from redacted data. */
export function buildSafeRetry(execution: RetryableExecution) {
  if (execution.status !== 'error') {
    throw new SafeRetryError('EXECUTION_NOT_RETRYABLE', 'Only failed executions can be retried');
  }

  if (SOURCE_WORKFLOWS.has(execution.workflow_id)) {
    throw new SafeRetryError(
      'SOURCE_REUPLOAD_REQUIRED',
      'This workflow requires a fresh source upload',
    );
  }

  if (!RECONSTRUCTABLE_WORKFLOWS.has(execution.workflow_id)
    || !execution.tender_id
    || !UUID_PATTERN.test(execution.tender_id)) {
    throw new SafeRetryError('EXECUTION_NOT_RETRYABLE', 'Execution cannot be retried safely');
  }

  return {
    workflowId: execution.workflow_id,
    triggerPayload: { tender_id: execution.tender_id },
    correlationId: execution.correlation_id ?? undefined,
  };
}
