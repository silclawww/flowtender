import { NextResponse } from 'next/server';
import { listWorkflows, loadWorkflow } from '@/lib/runner/loader';

export async function GET() {
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

    return NextResponse.json(workflows);
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
