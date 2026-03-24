export type NodeType =
  | 'code'
  | 'http_request'
  | 'supabase.query'
  | 'supabase.upsert'
  | 'supabase.update'
  | 'switch'
  | 'if'
  | 'wait'
  | 'respond'
  | 'gaeb_parse';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  name: string;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface WorkflowEdge {
  from: string;
  from_output: number;
  to: string;
  to_input?: number;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  version?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}
