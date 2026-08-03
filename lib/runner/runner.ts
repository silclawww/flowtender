import { v4 as uuidv4 } from 'uuid';
import { loadWorkflow } from './loader.ts';
import { codeExecutor } from '../nodes/code.ts';
import { httpRequestExecutor } from '../nodes/http-request.ts';
import { supabaseExecutors } from '../nodes/supabase.ts';
import { controlExecutors } from '../nodes/control.ts';
import { gaebParseExecutor } from '../nodes/gaeb.ts';
import { createServiceClient } from '../supabase/service.ts';
import {
  isTelemetryPersistenceError,
  persistExactlyOneTelemetryRow,
  TelemetryPersistenceError,
} from '../telemetry-persistence.ts';
import {
  completeExecutionTelemetry,
  completeNodeTelemetry,
  createExecutionTelemetry,
  createNodeTelemetry,
  normalizeCorrelationId,
  type SafeErrorCode,
} from '../telemetry.ts';
import {
  materializeWorkflowPayload,
  preflightWorkflowPayload,
} from '../tenant-context.ts';
import { claimPipelineAdmission, releasePipelineAdmission } from '../admission-control.ts';
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
  retryRootExecutionId?: string; // Immutable root used for retry-cost accounting
}

export interface ExecutionResult {
  execution_id: string;
  status: 'done' | 'error';
  response_payload?: ExecutionItem[];  // Payload from 'respond' node
  error_code?: SafeErrorCode;
  duration_ms: number;
}

export class WorkflowRunner {
  private readonly supabase: ReturnType<typeof createServiceClient>;
  private readonly workflowLoader: typeof loadWorkflow;

  constructor(
    supabase?: ReturnType<typeof createServiceClient>,
    workflowLoader: typeof loadWorkflow = loadWorkflow,
  ) {
    try {
      this.supabase = supabase ?? createServiceClient();
      this.workflowLoader = workflowLoader;
    } catch {
      throw new TelemetryPersistenceError();
    }
  }

  async run(
    workflowId: string,
    triggerPayload: Record<string, unknown>,
    options: RunOptions = {}
  ): Promise<ExecutionResult> {
    const preflight = preflightWorkflowPayload(workflowId, triggerPayload);

    const executionId = uuidv4();
    const startTime = Date.now();
    const { synchronous = true, timeoutMs = 120000 } = options;
    const correlationId = preflight.trustedContext
      ? normalizeCorrelationId(options.retryRootExecutionId, executionId)
      : normalizeCorrelationId(options.correlationId, executionId);

    let receiverOwnedLease: string | null = null;
    if (preflight.trustedContext) {
      await claimPipelineAdmission(this.supabase, {
        leaseId: preflight.trustedContext.admission_id,
        actorUserId: preflight.trustedContext.user_id,
        orgId: preflight.trustedContext.org_id,
        operation: options.retryRootExecutionId
          ? 'retry'
          : preflight.trustedContext.operation,
        rootExecutionId: correlationId,
      });
      if (preflight.trustedContext.operation !== 'upload') {
        receiverOwnedLease = preflight.trustedContext.admission_id;
      }
    }

    try {
      // Business payload traversal is deliberately deferred until the durable
      // admission has been claimed. This prevents rejected/replayed requests
      // from consuming clone, telemetry, parser, or LLM work.
      const materialized = materializeWorkflowPayload(workflowId, preflight);
      const resolvedWorkflowId = materialized.workflowId;
      const workflowPayload = materialized.payload;
      const tender_id = preflight.trustedContext?.tender_id
        ?? (workflowPayload.tender_id as string | undefined);
      const isStageOneUpload = preflight.trustedContext?.operation === 'upload';

      // Stage 1 creates the tender inside the workflow, so its telemetry row
      // cannot satisfy the immediate tender foreign key yet. Link the same
      // redacted execution row only after the workflow (including its tender
      // upsert) has completed successfully. Existing-tender stages keep their
      // link from the start.
      await persistExactlyOneTelemetryRow(() => this.supabase
      .from('flow_executions')
      .insert(createExecutionTelemetry({
        executionId,
        workflowId: resolvedWorkflowId,
        tenderId: isStageOneUpload ? null : tender_id,
        correlationId,
        startedAt: new Date().toISOString(),
      }) as any)
      .select('id'));

    let responsePayload: ExecutionItem[] | undefined;
    let executionErrorCode: SafeErrorCode | undefined;
    let telemetryFailure: TelemetryPersistenceError | undefined;

    try {
      let workflow: ReturnType<typeof loadWorkflow>;
      try {
        workflow = this.workflowLoader(resolvedWorkflowId);
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
      const triggerItems: ExecutionItem[] = [{ json: workflowPayload }];

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
        await persistExactlyOneTelemetryRow(() => this.supabase
          .from('flow_node_runs')
          .insert(createNodeTelemetry({
            executionId,
            stage: node.id,
            correlationId,
            startedAt: new Date().toISOString(),
          }) as any)
          .select('execution_id, stage'));

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
        await persistExactlyOneTelemetryRow(() => (this.supabase
          .from('flow_node_runs') as any)
          .update(completeNodeTelemetry({
            status: nodeErrorCode ? 'error' : 'done',
            safeErrorCode: nodeErrorCode ?? null,
            completedAt: new Date().toISOString(),
            durationMs: nodeDuration,
          }))
          .eq('execution_id', executionId)
          .eq('stage', node.id)
          .select('execution_id, stage'));

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

    } catch (error) {
      if (isTelemetryPersistenceError(error)) {
        telemetryFailure = error;
        executionErrorCode = 'TELEMETRY_PERSISTENCE_FAILED';
      } else {
        executionErrorCode ??= 'EXECUTION_FAILED';
      }
      console.error(`[flowtender] execution ${executionId} failed with ${executionErrorCode}`);
    }

    const duration = Date.now() - startTime;
    const completion = {
      ...completeExecutionTelemetry({
        status: executionErrorCode ? 'error' : 'done',
        safeErrorCode: executionErrorCode ?? null,
        completedAt: new Date().toISOString(),
        durationMs: duration,
      }),
      ...(isStageOneUpload && !executionErrorCode && tender_id
        ? { tender_id }
        : {}),
    };

    // Update execution record
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistExactlyOneTelemetryRow(() => (this.supabase
      .from('flow_executions') as any)
      .update(completion)
      .eq('id', executionId)
      .select('id'));

    if (telemetryFailure) throw telemetryFailure;

      return {
        execution_id: executionId,
        status: executionErrorCode ? 'error' : 'done',
        response_payload: responsePayload,
        error_code: executionErrorCode,
        duration_ms: duration,
      };
    } finally {
      if (receiverOwnedLease) {
        await releasePipelineAdmission(this.supabase, receiverOwnedLease);
      }
    }
  }
}

// Singleton factory
let _runner: WorkflowRunner | null = null;
export function getRunner(): WorkflowRunner {
  if (!_runner) _runner = new WorkflowRunner();
  return _runner;
}
