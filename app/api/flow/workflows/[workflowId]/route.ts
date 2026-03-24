import { NextRequest, NextResponse } from 'next/server';
import { loadWorkflow } from '@/lib/runner/loader';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const { workflowId } = await params;
  
  try {
    const wf = loadWorkflow(workflowId);
    // Return workflow definition (without code contents for security)
    return NextResponse.json({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      version: wf.version,
      nodes: wf.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        name: n.name,
        position: n.position,
        // Exclude config to avoid exposing sensitive data
      })),
      edges: wf.edges,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Workflow not found';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
