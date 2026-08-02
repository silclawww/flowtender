import { NextRequest, NextResponse } from 'next/server';
import { isOperatorAuthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';

export async function GET(request: NextRequest) {
  if (!isOperatorAuthorized(request.headers)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('flow_executions')
      .select('id, workflow_id, status, tender_id, started_at, completed_at, duration_ms, safe_error_code, correlation_id')
      .order('started_at', { ascending: false })
      .limit(50);
    
    if (error) throw error;
    return NextResponse.json(data || [], { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return NextResponse.json(
      { error: 'Telemetry unavailable' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
