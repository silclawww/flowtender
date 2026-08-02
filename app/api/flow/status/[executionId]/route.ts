import { NextRequest, NextResponse } from 'next/server';
import { isOperatorAuthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';

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
  const supabase = createServiceClient();
  
  const { data: execution, error: execError } = await supabase
    .from('flow_executions')
    .select('id, workflow_id, status, tender_id, started_at, completed_at, duration_ms, safe_error_code, correlation_id')
    .eq('id', executionId)
    .single();
  
  if (execError || !execution) {
    return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
  }
  
  const { data: nodeRuns } = await supabase
    .from('flow_node_runs')
    .select('execution_id, stage, status, started_at, completed_at, duration_ms, safe_error_code, correlation_id')
    .eq('execution_id', executionId)
    .order('started_at', { ascending: true });
  
  const exec = execution as Record<string, unknown>;
  return NextResponse.json(
    { ...exec, node_runs: nodeRuns || [] },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
