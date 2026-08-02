import { NextRequest, NextResponse } from 'next/server';
import { isServiceAuthorized } from '@/lib/auth';
import { getRunner } from '@/lib/runner';
import { isTelemetryPersistenceError } from '@/lib/telemetry-persistence';
import { AdmissionControlError } from '@/lib/admission-control';

// Pipeline stages run synchronous LLM calls; allow long serverless execution on Vercel
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  if (!isServiceAuthorized(request.headers)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { workflowId } = await params;
  
  let payload: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) payload = JSON.parse(text);
  } catch {
    // Empty body is fine for some workflows
  }
  
  try {
    const runner = getRunner();
    const result = await runner.run(workflowId, payload, {
      synchronous: true,
      correlationId: request.headers.get('x-correlation-id') ?? undefined,
    });
    
    if (result.status === 'error') {
      return NextResponse.json(
        { error_code: result.error_code, execution_id: result.execution_id },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    
    // Return the payload from the 'respond' node (or empty object)
    const responseData = result.response_payload?.[0]?.json || { 
      execution_id: result.execution_id,
      status: result.status 
    };
    
    return NextResponse.json(responseData, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AdmissionControlError) {
      return NextResponse.json(
        { error_code: error.code },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
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
}
