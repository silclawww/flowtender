import { NextRequest, NextResponse } from 'next/server';
import { isOperatorAuthorized } from '@/lib/auth';
import { buildSafeRetry, SafeRetryError } from '@/lib/retry';
import { createServiceClient } from '@/lib/supabase/service';
import { getRunner } from '@/lib/runner';

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
  const supabase = createServiceClient();
  
  const { data: execution, error } = await supabase
    .from('flow_executions')
    .select('workflow_id, tender_id, status, correlation_id')
    .eq('id', executionId)
    .single();
  
  if (error || !execution) {
    return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
  }
  
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

  const runner = getRunner();
  const result = await runner.run(
    retry.workflowId,
    retry.triggerPayload,
    { synchronous: true, correlationId: retry.correlationId },
  );
  
  return NextResponse.json(
    {
      new_execution_id: result.execution_id,
      status: result.status,
      error_code: result.error_code,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
