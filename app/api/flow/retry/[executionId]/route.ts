import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { getRunner } from '@/lib/runner';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> }
) {
  const { executionId } = await params;
  const supabase = createServiceClient();
  
  const { data: execution, error } = await supabase
    .from('flow_executions')
    .select('workflow_id, trigger_payload')
    .eq('id', executionId)
    .single();
  
  if (error || !execution) {
    return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
  }
  
  const exec = execution as { workflow_id: string; trigger_payload: Record<string, unknown> | null };
  const runner = getRunner();
  const result = await runner.run(
    exec.workflow_id,
    (exec.trigger_payload ?? {}) as Record<string, unknown>,
    { synchronous: true }
  );
  
  return NextResponse.json({ new_execution_id: result.execution_id, status: result.status });
}
