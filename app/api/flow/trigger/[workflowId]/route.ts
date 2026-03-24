import { NextRequest, NextResponse } from 'next/server';
import { getRunner } from '@/lib/runner';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const { workflowId } = await params;
  
  // Auth check — accept service role key or dedicated FLOWTENDER_API_KEY
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const apiKey = process.env.FLOWTENDER_API_KEY || serviceKey;
  
  if (token !== apiKey && token !== serviceKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  let payload: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) payload = JSON.parse(text);
  } catch {
    // Empty body is fine for some workflows
  }
  
  const runner = getRunner();
  
  try {
    const result = await runner.run(workflowId, payload, { synchronous: true });
    
    if (result.status === 'error') {
      return NextResponse.json(
        { error: result.error, execution_id: result.execution_id },
        { status: 500 }
      );
    }
    
    // Return the payload from the 'respond' node (or empty object)
    const responseData = result.response_payload?.[0]?.json || { 
      execution_id: result.execution_id,
      status: result.status 
    };
    
    return NextResponse.json(responseData);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
