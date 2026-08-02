import { NextRequest, NextResponse } from 'next/server';
import { isOperatorAuthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { classifyListQuery, classifySingleQuery } from '@/lib/query-result';

function telemetryUnavailable() {
  return NextResponse.json(
    { error: 'Telemetry unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function GET(
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
      .select('id, workflow_id, status, tender_id, started_at, completed_at, duration_ms, safe_error_code, correlation_id')
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
  
  let nodeRunsResult;
  try {
    nodeRunsResult = await supabase
      .from('flow_node_runs')
      .select('execution_id, stage, status, started_at, completed_at, duration_ms, safe_error_code, correlation_id')
      .eq('execution_id', executionId)
      .order('started_at', { ascending: true });
  } catch {
    return telemetryUnavailable();
  }

  const classifiedNodeRuns = classifyListQuery(nodeRunsResult);
  if (classifiedNodeRuns.kind === 'operational_error') return telemetryUnavailable();
  
  const exec = classifiedExecution.data as Record<string, unknown>;
  return NextResponse.json(
    { ...exec, node_runs: classifiedNodeRuns.data },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
