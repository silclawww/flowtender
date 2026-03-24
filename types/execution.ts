export type ExecutionStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface ExecutionItem {
  json: Record<string, unknown>;
}

export interface NodeRun {
  id: string;
  execution_id: string;
  node_id: string;
  node_type: string;
  node_name: string;
  input: ExecutionItem[];
  output: ExecutionItem[];
  status: ExecutionStatus;
  error?: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface WorkflowExecution {
  id: string;
  workflow_id: string;
  trigger_payload: Record<string, unknown>;
  status: ExecutionStatus;
  tender_id?: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  error?: string;
  node_runs?: NodeRun[];
}

export type ExecutionContext = Map<string, ExecutionItem[]>;

export interface NodeExecutor {
  execute(
    config: Record<string, unknown>,
    input: ExecutionItem[],
    context: ExecutionContext
  ): Promise<ExecutionItem[][]>;
}
