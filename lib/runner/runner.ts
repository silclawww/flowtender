import { v4 as uuidv4 } from 'uuid';
import { loadWorkflow } from './loader';
import { codeExecutor } from '@/lib/nodes/code';
import { httpRequestExecutor } from '@/lib/nodes/http-request';
import { supabaseExecutors } from '@/lib/nodes/supabase';
import { controlExecutors } from '@/lib/nodes/control';
import { gaebParseExecutor } from '@/lib/nodes/gaeb';
import { createServiceClient } from '@/lib/supabase/service';
import type { WorkflowNode } from '@/types/workflow';
import type { ExecutionItem, ExecutionContext, NodeExecutor } from '@/types/execution';

// Registry of all node executors
const NODE_EXECUTORS: Record<string, NodeExecutor> = {
  code: codeExecutor,
  http_request: httpRequestExecutor,
  gaeb_parse: gaebParseExecutor,
  ...supabaseExecutors,
  ...controlExecutors,
};

export interface RunOptions {
  synchronous?: boolean;  // If true, wait for 'respond' node before returning
  timeoutMs?: number;     // Max execution time (default: 120000ms)
}

export interface ExecutionResult {
  execution_id: string;
  status: 'done' | 'error';
  response_payload?: ExecutionItem[];  // Payload from 'respond' node
  error?: string;
  duration_ms: number;
}

export class WorkflowRunner {
  private supabase = createServiceClient();

  async run(
    workflowId: string,
    triggerPayload: Record<string, unknown>,
    options: RunOptions = {}
  ): Promise<ExecutionResult> {
    const executionId = uuidv4();
    const startTime = Date.now();
    const { synchronous = true, timeoutMs = 120000 } = options;

    // Detect tender_id in payload
    const tender_id = triggerPayload.tender_id as string | undefined ||
                      (triggerPayload.body as Record<string,unknown>)?.tender_id as string | undefined;

    // Create execution record
    await this.supabase.from('flow_executions').insert({
      id: executionId,
      workflow_id: workflowId,
      trigger_payload: triggerPayload,
      status: 'running',
      tender_id: tender_id || null,
      started_at: new Date().toISOString(),
    } as any);

    let responsePayload: ExecutionItem[] | undefined;
    let executionError: string | undefined;

    try {
      const workflow = loadWorkflow(workflowId);
      
      // Build adjacency: nodeId → list of { to_node_id, to_port, from_port }
      const outEdges = new Map<string, Array<{ to: string; from_output: number; to_input: number }>>();
      for (const node of workflow.nodes) outEdges.set(node.id, []);
      for (const edge of workflow.edges) {
        const list = outEdges.get(edge.from) || [];
        list.push({ to: edge.to, from_output: edge.from_output ?? 0, to_input: edge.to_input ?? 0 });
        outEdges.set(edge.from, list);
      }

      // Find start nodes (no incoming edges)
      const incomingCount = new Map<string, number>();
      for (const node of workflow.nodes) incomingCount.set(node.id, 0);
      for (const edge of workflow.edges) incomingCount.set(edge.to, (incomingCount.get(edge.to) || 0) + 1);
      const startNodes = workflow.nodes.filter(n => (incomingCount.get(n.id) || 0) === 0);

      // Execution context: nodeId → output items
      const context: ExecutionContext = new Map();

      // Initial input for start nodes = trigger payload
      const triggerItems: ExecutionItem[] = [{ json: triggerPayload }];

      // BFS execution queue: { nodeId, input }
      const queue: Array<{ node: WorkflowNode; input: ExecutionItem[] }> = 
        startNodes.map(n => ({ node: n, input: triggerItems }));
      
      const executed = new Set<string>();
      const timeout = Date.now() + timeoutMs;

      while (queue.length > 0 && Date.now() < timeout) {
        const { node, input } = queue.shift()!;
        if (executed.has(node.id)) continue;
        executed.add(node.id);

        const nodeRunId = uuidv4();
        const nodeStart = Date.now();

        // Mark node as running
        await this.supabase.from('flow_node_runs').insert({
          id: nodeRunId,
          execution_id: executionId,
          node_id: node.id,
          node_type: node.type,
          node_name: node.name,
          input: input,
          status: 'running',
          started_at: new Date().toISOString(),
        } as any);

        let outputs: ExecutionItem[][] = [];
        let nodeError: string | undefined;

        try {
          const executor = NODE_EXECUTORS[node.type];
          if (!executor) throw new Error(`Unknown node type: ${node.type}`);
          
          outputs = await executor.execute(node.config, input, context);
          
          // For 'respond' nodes, capture the response payload
          if (node.type === 'respond' && synchronous) {
            responsePayload = outputs[0] || input;
          }
          
          // Store this node's output in context (port 0 output)
          context.set(node.id, outputs[0] || []);

        } catch (err) {
          nodeError = err instanceof Error ? err.message : String(err);
          outputs = [[]];
          context.set(node.id, []);
          console.error(`[flowtender] Node ${node.id} (${node.type}) error:`, nodeError);
        }

        const nodeDuration = Date.now() - nodeStart;

        // Update node run record
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (this.supabase.from('flow_node_runs') as any).update({
          output: outputs[0] || [],
          status: nodeError ? 'error' : 'done',
          error: nodeError || null,
          completed_at: new Date().toISOString(),
          duration_ms: nodeDuration,
        }).eq('id', nodeRunId);

        if (nodeError) {
          // On error, stop the execution
          executionError = `Node "${node.name}" (${node.id}) failed: ${nodeError}`;
          break;
        }

        // Enqueue downstream nodes for each output port
        const edges = outEdges.get(node.id) || [];
        for (const edge of edges) {
          const portOutput = outputs[edge.from_output] || [];
          if (portOutput.length === 0) continue; // Empty branch — skip
          
          const nextNode = workflow.nodes.find(n => n.id === edge.to);
          if (nextNode && !executed.has(nextNode.id)) {
            queue.push({ node: nextNode, input: portOutput });
          }
        }
      }

      if (Date.now() >= timeout && queue.length > 0) {
        executionError = 'Execution timed out';
      }

    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
      console.error(`[flowtender] Execution ${executionId} failed:`, executionError);
    }

    const duration = Date.now() - startTime;

    // Update execution record
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.supabase.from('flow_executions') as any).update({
      status: executionError ? 'error' : 'done',
      completed_at: new Date().toISOString(),
      duration_ms: duration,
      error: executionError || null,
    }).eq('id', executionId);

    return {
      execution_id: executionId,
      status: executionError ? 'error' : 'done',
      response_payload: responsePayload,
      error: executionError,
      duration_ms: duration,
    };
  }
}

// Singleton factory
let _runner: WorkflowRunner | null = null;
export function getRunner(): WorkflowRunner {
  if (!_runner) _runner = new WorkflowRunner();
  return _runner;
}
