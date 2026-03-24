import { NextRequest, NextResponse } from 'next/server';
import { getRunner } from '@/lib/runner';

// Map webhook path to workflow ID
function resolveWorkflowId(path: string, payload: Record<string, unknown>): string {
  switch (path) {
    case 'tender-metadata': {
      // Route to GAEB or PDF workflow based on file_type
      const fileType = (payload.file_type as string) ||
                       (payload.body as Record<string,unknown>)?.file_type as string || 'pdf';
      return fileType === 'pdf' ? 'tender-stage1-pdf' : 'tender-stage1-gaeb';
    }
    case 'tender-details':
      return 'tender-stage2-requirements';
    case 'tender-evaluation':
      return 'tender-stage3-evaluation';
    default:
      throw new Error(`Unknown webhook path: ${path}`);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string }> }
) {
  const { path } = await params;
  
  // No auth required for internal calls from Tenderly (same server)
  // But accept optional Bearer token anyway for safety
  // We skip strict auth here because Tenderly's upload route doesn't send a token
  // to these webhook-equivalent URLs
  
  let payload: Record<string, unknown> = {};
  try {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      payload = await request.json();
    } else {
      const text = await request.text();
      if (text) payload = JSON.parse(text);
    }
  } catch {
    // Empty body ok
  }
  
  let workflowId: string;
  try {
    workflowId = resolveWorkflowId(path, payload);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 404 });
  }
  
  const runner = getRunner();
  
  try {
    console.log(`[flowtender] webhook/${path} → workflow: ${workflowId}`);
    const result = await runner.run(workflowId, payload, { synchronous: true });
    
    if (result.status === 'error') {
      console.error(`[flowtender] workflow ${workflowId} failed:`, result.error);
      return NextResponse.json(
        { error: result.error, execution_id: result.execution_id },
        { status: 500 }
      );
    }
    
    const responseData = result.response_payload?.[0]?.json || {
      execution_id: result.execution_id,
      status: result.status,
    };
    
    console.log(`[flowtender] webhook/${path} completed in ${result.duration_ms}ms`);
    return NextResponse.json(responseData);
    
  } catch (err) {
    console.error(`[flowtender] webhook/${path} error:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ status: 'ok', service: 'flowtender' });
}
