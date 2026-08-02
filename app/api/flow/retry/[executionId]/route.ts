import { NextRequest, NextResponse } from 'next/server';
import { isOperatorAuthorized } from '@/lib/auth';
import { handleRetryExecution } from '@/lib/retry-handler';
import { createServiceClient } from '@/lib/supabase/service';
import { getRunner } from '@/lib/runner';
import { acquirePipelineAdmission } from '@/lib/admission-control';

// Retried LLM stages need the same serverless window as initial processing.
export const maxDuration = 300;

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
    return NextResponse.json(
      { error_code: 'TELEMETRY_UNAVAILABLE' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return handleRetryExecution(executionId, {
    loadExecution: () => supabase
      .from('flow_executions')
      .select('workflow_id, tender_id, status, correlation_id')
      .eq('id', executionId)
      .single(),
    loadRetryContext: (rootExecutionId) => supabase
      .from('pipeline_admissions')
      .select('actor_user_id, org_id')
      .eq('root_execution_id', rootExecutionId)
      .not('claimed_at', 'is', null)
      .order('admitted_at', { ascending: true })
      .limit(1)
      .single(),
    loadTenderOrg: (tenderId) => supabase
      .from('tenders')
      .select('org_id')
      .eq('id', tenderId)
      .single(),
    runWorkflow: (workflowId, payload, options) => getRunner().run(
      workflowId,
      payload,
      options,
    ),
    acquireAdmission: (input) => acquirePipelineAdmission(supabase, input),
  });
}
