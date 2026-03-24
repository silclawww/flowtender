import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function GET() {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('flow_executions')
      .select('id, workflow_id, status, tender_id, started_at, completed_at, duration_ms, error')
      .order('started_at', { ascending: false })
      .limit(50);
    
    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
