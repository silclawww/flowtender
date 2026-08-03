export type SafeRetryErrorCode =
  | 'EXECUTION_NOT_RETRYABLE'
  | 'RETRY_TENANT_CONTEXT_INVALID'
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

export interface RetryableExecution {
  workflow_id: string;
  tender_id: string | null;
  status: string;
  correlation_id: string | null;
}

export interface RetryActorContext {
  actor_user_id: string | null;
  org_id: string | null;
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

export function prepareSafeRetry(execution: RetryableExecution) {
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

  if (!execution.correlation_id || !UUID_PATTERN.test(execution.correlation_id)) {
    throw new SafeRetryError('RETRY_TENANT_CONTEXT_INVALID', 'Retry tenant context is invalid');
  }

  return {
    workflowId: execution.workflow_id,
    tenderId: execution.tender_id,
    correlationId: execution.correlation_id ?? undefined,
    retryRootExecutionId: execution.correlation_id.toLowerCase(),
  };
}

/** Build the only retry payload reconstructable from redacted and immutable data. */
export function buildSafeRetry(
  execution: RetryableExecution,
  orgId?: string | null,
  actorContext?: RetryActorContext,
) {
  const prepared = prepareSafeRetry(execution);
  if (!orgId || !UUID_PATTERN.test(orgId)) {
    throw new SafeRetryError(
      'RETRY_TENANT_CONTEXT_INVALID',
      'Retry tenant context is invalid',
    );
  }
  if (!actorContext?.actor_user_id || !UUID_PATTERN.test(actorContext.actor_user_id)
    || !actorContext.org_id || !UUID_PATTERN.test(actorContext.org_id)
    || orgId.toLowerCase() !== actorContext.org_id.toLowerCase()) {
    throw new SafeRetryError(
      'RETRY_TENANT_CONTEXT_INVALID',
      'Retry tenant context is invalid',
    );
  }

  return {
    workflowId: prepared.workflowId,
    triggerPayload: {
      tender_id: prepared.tenderId,
      org_id: actorContext.org_id.toLowerCase(),
      user_id: actorContext.actor_user_id.toLowerCase(),
    },
    correlationId: prepared.correlationId,
    actorUserId: actorContext.actor_user_id.toLowerCase(),
    orgId: actorContext.org_id.toLowerCase(),
    retryRootExecutionId: prepared.retryRootExecutionId,
  };
}
