import { v4 as uuidv4 } from 'uuid';
import { loadWorkflow } from './loader';
import { codeExecutor } from '@/lib/nodes/code';
import { httpRequestExecutor } from '@/lib/nodes/http-request';
import { supabaseExecutors } from '@/lib/nodes/supabase';
import { controlExecutors } from '@/lib/nodes/control';
import { gaebParseExecutor } from '@/lib/nodes/gaeb';
import { createServiceClient } from '@/lib/supabase/service';
import {
  completeExecutionTelemetry,
  completeNodeTelemetry,
  createExecutionTelemetry,
  createNodeTelemetry,
  normalizeCorrelationId,
  type SafeErrorCode,
} from '@/lib/telemetry';
import type { WorkflowNode, NodeRetryConfig } from '@/types/workflow';
import type { ExecutionItem, ExecutionContext, NodeExecutor } from '@/types/execution';

/**
 * Execute a node with retry logic for transient failures
 */
async function executeWithRetry(
  executor: NodeExecutor,
  config: Record<string, unknown>,
  input: ExecutionItem[],
  context: ExecutionContext,
  retry: NodeRetryConfig = {}
): Promise<ExecutionItem[][]> {
  const maxAttempts = retry.max_attempts ?? 1;
  const delayMs = retry.delay_ms ?? 1000;
  const backoff = retry.backoff ?? 'linear';
  
  let lastError: Error | undefined;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await executor.execute(config, input, context);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      if (attempt < maxAttempts) {
        const wait = backoff === 'exponential' 
          ? delayMs * Math.pow(2, attempt - 1)
          : delayMs * attempt;
        console.warn(`[runner] node retry ${attempt}/${maxAttempts}, waiting ${wait}ms...`);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }
  
  throw lastError!;
}

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
  correlationId?: string; // Opaque request identifier; unsafe values are discarded
}

export interface ExecutionResult {
  execution_id: string;
  status: 'done' | 'error';
  response_payload?: ExecutionItem[];  // Payload from 'respond' node
  error_code?: SafeErrorCode;
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
    const correlationId = normalizeCorrelationId(options.correlationId, executionId);

    // Detect tender_id in payload
    const tender_id = triggerPayload.tender_id as string | undefined ||
                      (triggerPayload.body as Record<string,unknown>)?.tender_id as string | undefined;

    // Create execution record
    await this.supabase.from('flow_executions').insert(createExecutionTelemetry({
      executionId,
      workflowId,
      tenderId: tender_id,
      correlationId,
      startedAt: new Date().toISOString(),
    }) as any);

    let responsePayload: ExecutionItem[] | undefined;
    let executionErrorCode: SafeErrorCode | undefined;

    try {
      let workflow: ReturnType<typeof loadWorkflow>;
      try {
        workflow = loadWorkflow(workflowId);
      } catch {
        executionErrorCode = 'WORKFLOW_LOAD_FAILED';
        throw new Error('Workflow load failed');
      }
      
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

        const nodeStart = Date.now();

        // Mark node as running
        await this.supabase.from('flow_node_runs').insert(createNodeTelemetry({
          executionId,
          stage: node.id,
          correlationId,
          startedAt: new Date().toISOString(),
        }) as any);

        let outputs: ExecutionItem[][] = [];
        let nodeErrorCode: SafeErrorCode | undefined;

        try {
          const executor = NODE_EXECUTORS[node.type];
          if (!executor) {
            nodeErrorCode = 'UNKNOWN_NODE_TYPE';
            throw new Error('Unknown node type');
          }
          
          outputs = await executeWithRetry(executor, node.config, input, context, node.retry);
          
          // For 'respond' nodes, capture the response payload
          if (node.type === 'respond' && synchronous) {
            responsePayload = outputs[0] || input;
          }
          
          // Store this node's output in context (port 0 output)
          context.set(node.id, outputs[0] || []);

        } catch {
          nodeErrorCode ??= 'NODE_EXECUTION_FAILED';
          outputs = [[]];
          context.set(node.id, []);
          console.error(`[flowtender] stage ${node.id} failed with ${nodeErrorCode}`);
        }

        const nodeDuration = Date.now() - nodeStart;

        // Update node run record
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (this.supabase.from('flow_node_runs') as any).update(completeNodeTelemetry({
          status: nodeErrorCode ? 'error' : 'done',
          safeErrorCode: nodeErrorCode ?? null,
          completedAt: new Date().toISOString(),
          durationMs: nodeDuration,
        }))
          .eq('execution_id', executionId)
          .eq('stage', node.id);

        if (nodeErrorCode) {
          // On error, stop the execution
          executionErrorCode = nodeErrorCode;
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
        executionErrorCode = 'EXECUTION_TIMED_OUT';
      }

    } catch {
      executionErrorCode ??= 'EXECUTION_FAILED';
      console.error(`[flowtender] execution ${executionId} failed with ${executionErrorCode}`);
    }

    const duration = Date.now() - startTime;

    // Update execution record
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.supabase.from('flow_executions') as any).update(completeExecutionTelemetry({
      status: executionErrorCode ? 'error' : 'done',
      safeErrorCode: executionErrorCode ?? null,
      completedAt: new Date().toISOString(),
      durationMs: duration,
    })).eq('id', executionId);

    return {
      execution_id: executionId,
      status: executionErrorCode ? 'error' : 'done',
      response_payload: responsePayload,
      error_code: executionErrorCode,
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
