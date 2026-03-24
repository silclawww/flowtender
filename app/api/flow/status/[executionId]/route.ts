import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> }
) {
  const { executionId } = await params;
  const supabase = createServiceClient();
  
  const { data: execution, error: execError } = await supabase
    .from('flow_executions')
    .select('*')
    .eq('id', executionId)
    .single();
  
  if (execError || !execution) {
    return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
  }
  
  const { data: nodeRuns } = await supabase
    .from('flow_node_runs')
    .select('*')
    .eq('execution_id', executionId)
    .order('started_at', { ascending: true });
  
  const exec = execution as Record<string, unknown>;
  return NextResponse.json({ ...exec, node_runs: nodeRuns || [] });
}
