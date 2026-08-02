import { NextRequest, NextResponse } from 'next/server';
import { isOperatorAuthorized } from '@/lib/auth';
import { loadWorkflow } from '@/lib/runner/loader';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  if (!isOperatorAuthorized(request.headers)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { workflowId } = await params;
  
  try {
    const wf = loadWorkflow(workflowId);
    // Return workflow definition (without code contents for security)
    return NextResponse.json(
      {
        id: wf.id,
        name: wf.name,
        description: wf.description,
        version: wf.version,
        nodes: wf.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          name: n.name,
          position: n.position,
          // Exclude config to avoid exposing prompts, credentials, and payload templates.
        })),
        edges: wf.edges,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch {
    return NextResponse.json(
      { error: 'Workflow not found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
