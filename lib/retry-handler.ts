import { classifySingleQuery } from './query-result.ts';
import {
  buildSafeRetry,
  prepareSafeRetry,
  SafeRetryError,
  type RetryableExecution,
} from './retry.ts';
import { isTelemetryPersistenceError } from './telemetry-persistence.ts';
import { AdmissionControlError } from './admission-control.ts';

interface QueryResult<T> {
  data: T | null;
  error: { code?: string; message?: string } | null;
}

interface RetryRunResult {
  execution_id: string;
  status: 'done' | 'error';
  error_code?: string;
  duration_ms: number;
}

export interface RetryDependencies {
  loadExecution(executionId: string): PromiseLike<QueryResult<RetryableExecution>>;
  loadRetryContext(rootExecutionId: string): PromiseLike<QueryResult<{
    actor_user_id: string | null;
    org_id: string | null;
  }>>;
  loadTenderOrg(tenderId: string): PromiseLike<QueryResult<{ org_id: string | null }>>;
  runWorkflow(
    workflowId: string,
    payload: Record<string, unknown>,
    options: { synchronous: true; correlationId?: string; retryRootExecutionId?: string },
  ): Promise<RetryRunResult>;
  acquireAdmission(input: {
    actorUserId: string;
    orgId: string;
    operation: 'retry';
    retryRootExecutionId: string;
  }): Promise<string>;
  releaseAdmission(leaseId: string): Promise<void>;
}

function errorResponse(errorCode: string, status: number) {
  return Response.json(
    { error_code: errorCode },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function handleRetryExecution(
  executionId: string,
  dependencies: RetryDependencies,
): Promise<Response> {
  let executionResult: QueryResult<RetryableExecution>;
  try {
    executionResult = await dependencies.loadExecution(executionId);
  } catch {
    return errorResponse('TELEMETRY_UNAVAILABLE', 503);
  }

  const classifiedExecution = classifySingleQuery(executionResult);
  if (classifiedExecution.kind === 'not_found') {
    return errorResponse('EXECUTION_NOT_FOUND', 404);
  }
  if (classifiedExecution.kind === 'operational_error') {
    return errorResponse('TELEMETRY_UNAVAILABLE', 503);
  }

  let prepared;
  try {
    prepared = prepareSafeRetry(classifiedExecution.data);
  } catch (error) {
    if (error instanceof SafeRetryError) return errorResponse(error.code, 409);
    return errorResponse('EXECUTION_NOT_RETRYABLE', 409);
  }

  let actorContextResult: QueryResult<{ actor_user_id: string | null; org_id: string | null }>;
  try {
    actorContextResult = await dependencies.loadRetryContext(prepared.retryRootExecutionId);
  } catch {
    return errorResponse('RETRY_CONTEXT_UNAVAILABLE', 503);
  }
  const classifiedActorContext = classifySingleQuery(actorContextResult);
  if (classifiedActorContext.kind !== 'found') {
    return errorResponse('RETRY_CONTEXT_UNAVAILABLE', 503);
  }

  let tenderResult: QueryResult<{ org_id: string | null }>;
  try {
    tenderResult = await dependencies.loadTenderOrg(prepared.tenderId);
  } catch {
    return errorResponse('RETRY_CONTEXT_UNAVAILABLE', 503);
  }

  const classifiedTender = classifySingleQuery(tenderResult);
  if (classifiedTender.kind === 'not_found') {
    return errorResponse('RETRY_TENDER_NOT_FOUND', 404);
  }
  if (classifiedTender.kind === 'operational_error') {
    return errorResponse('RETRY_CONTEXT_UNAVAILABLE', 503);
  }

  let retry;
  try {
    retry = buildSafeRetry(
      classifiedExecution.data,
      classifiedTender.data.org_id,
      classifiedActorContext.data,
    );
  } catch (error) {
    if (error instanceof SafeRetryError) return errorResponse(error.code, 409);
    return errorResponse('EXECUTION_NOT_RETRYABLE', 409);
  }

  let leaseId: string;
  try {
    leaseId = await dependencies.acquireAdmission({
      actorUserId: retry.actorUserId,
      orgId: retry.orgId,
      operation: 'retry',
      retryRootExecutionId: retry.retryRootExecutionId,
    });
  } catch (error) {
    if (error instanceof AdmissionControlError) {
      return errorResponse(error.code, error.status);
    }
    return errorResponse('ADMISSION_UNAVAILABLE', 503);
  }

  try {
    const result = await dependencies.runWorkflow(
      retry.workflowId,
      { ...retry.triggerPayload, admission_id: leaseId },
      {
        synchronous: true,
        correlationId: retry.correlationId,
        retryRootExecutionId: retry.retryRootExecutionId,
      },
    );
    if (result.status === 'error') {
      return Response.json(
        {
          error_code: result.error_code ?? 'EXECUTION_FAILED',
          execution_id: result.execution_id,
        },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return Response.json(
      {
        new_execution_id: result.execution_id,
        status: result.status,
        error_code: result.error_code,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (isTelemetryPersistenceError(error)) return errorResponse(error.code, 503);
    return errorResponse('EXECUTION_FAILED', 500);
  } finally {
    await dependencies.releaseAdmission(leaseId).catch(() => undefined);
  }
}
