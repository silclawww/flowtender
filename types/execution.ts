export type ExecutionStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface ExecutionItem {
  json: Record<string, unknown>;
}

export interface NodeRun {
  execution_id: string;
  stage: string;
  status: ExecutionStatus;
  safe_error_code?: string;
  correlation_id: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface WorkflowExecution {
  id: string;
  workflow_id: string;
  status: ExecutionStatus;
  tender_id?: string;
  safe_error_code?: string;
  correlation_id: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  error?: string;
  node_runs?: NodeRun[];
}

export type ExecutionContext = Map<string, ExecutionItem[]>;

export interface ExecutionRuntime {
  deadline?: number;
}

export interface NodeExecutor {
  execute(
    config: Record<string, unknown>,
    input: ExecutionItem[],
    context: ExecutionContext,
    runtime?: ExecutionRuntime,
  ): Promise<ExecutionItem[][]>;
}
