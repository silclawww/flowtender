import { NextRequest, NextResponse } from 'next/server';
import { isOperatorAuthorized } from '@/lib/auth';
import { listWorkflows, loadWorkflow } from '@/lib/runner/loader';

export async function GET(request: NextRequest) {
  if (!isOperatorAuthorized(request.headers)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const workflowIds = listWorkflows();
    
    const workflows = workflowIds.map((id) => {
      try {
        const wf = loadWorkflow(id);
        return {
          id: wf.id,
          name: wf.name,
          description: wf.description || null,
          version: wf.version || null,
          nodeCount: wf.nodes.length,
          edgeCount: wf.edges.length,
        };
      } catch {
        return {
          id,
          name: id,
          description: null,
          version: null,
          nodeCount: 0,
          edgeCount: 0,
          error: 'Failed to load workflow',
        };
      }
    });

    return NextResponse.json(workflows, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return NextResponse.json(
      { error: 'Workflow metadata unavailable' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
