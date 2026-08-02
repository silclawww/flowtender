import { NextRequest, NextResponse } from 'next/server';
import { getRunner } from '@/lib/runner';

// Pipeline stages run synchronous LLM calls; allow long serverless execution on Vercel
export const maxDuration = 300;

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
  
  // Both apps are publicly reachable on Vercel — require the shared secret
  // (FLOWTENDER_API_KEY, falling back to the service-role key) when configured.
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const apiKey = process.env.FLOWTENDER_API_KEY || serviceKey;
  if (apiKey && token !== apiKey && token !== serviceKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
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
