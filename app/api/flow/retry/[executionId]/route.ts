import { NextRequest, NextResponse } from 'next/server';
import { isOperatorAuthorized } from '@/lib/auth';
import { buildSafeRetry, SafeRetryError } from '@/lib/retry';
import { createServiceClient } from '@/lib/supabase/service';
import { getRunner } from '@/lib/runner';
import { classifySingleQuery } from '@/lib/query-result';
import { isTelemetryPersistenceError } from '@/lib/telemetry-persistence';

// Retried LLM stages need the same serverless window as initial processing.
export const maxDuration = 300;

function telemetryUnavailable() {
  return NextResponse.json(
    { error: 'Telemetry unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> }
) {
  if (!isOperatorAuthorized(request.headers)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { executionId } = await params;
  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch {
    return telemetryUnavailable();
  }
  
  let executionResult;
  try {
    executionResult = await supabase
      .from('flow_executions')
      .select('workflow_id, tender_id, status, correlation_id')
      .eq('id', executionId)
      .single();
  } catch {
    return telemetryUnavailable();
  }
  
  const classifiedExecution = classifySingleQuery(executionResult);
  if (classifiedExecution.kind === 'not_found') {
    return NextResponse.json(
      { error: 'Execution not found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (classifiedExecution.kind === 'operational_error') return telemetryUnavailable();
  const execution = classifiedExecution.data;
  
  let retry;
  try {
    retry = buildSafeRetry(execution as {
      workflow_id: string;
      tender_id: string | null;
      status: string;
      correlation_id: string | null;
    });
  } catch (retryError) {
    if (retryError instanceof SafeRetryError) {
      return NextResponse.json(
        { error_code: retryError.code },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    throw retryError;
  }

  let result;
  try {
    const runner = getRunner();
    result = await runner.run(
      retry.workflowId,
      retry.triggerPayload,
      { synchronous: true, correlationId: retry.correlationId },
    );
  } catch (error) {
    if (isTelemetryPersistenceError(error)) {
      return NextResponse.json(
        { error_code: error.code },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.json(
      { error_code: 'EXECUTION_FAILED' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  
  return NextResponse.json(
    {
      new_execution_id: result.execution_id,
      status: result.status,
      error_code: result.error_code,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
