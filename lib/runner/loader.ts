import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowDefinition, WorkflowNode, WorkflowEdge } from '@/types/workflow';

// Resolve workflows directory relative to the project root (not __dirname which changes in Next.js)
// process.cwd() returns the project root in Next.js
const WORKFLOWS_DIR = path.join(process.cwd(), 'workflows');

/**
 * Load a workflow definition by ID.
 * Reads workflows/{workflowId}.json from the workflows directory.
 */
export function loadWorkflow(workflowId: string): WorkflowDefinition {
  // Sanitize workflowId to prevent path traversal
  const safeId = workflowId.replace(/[^a-zA-Z0-9\-_]/g, '');
  if (safeId !== workflowId) {
    throw new Error(`Invalid workflow ID: ${workflowId}`);
  }
  
  const filePath = path.join(WORKFLOWS_DIR, `${safeId}.json`);
  
  if (!fs.existsSync(filePath)) {
    throw new Error(`Workflow not found: ${workflowId} (looked at ${filePath})`);
  }
  
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in workflow ${workflowId}: ${e}`);
  }
  
  return validateWorkflow(parsed, workflowId);
}

/**
 * List all available workflow IDs (filenames without .json extension).
 */
export function listWorkflows(): string[] {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5));
}

/**
 * Validate a workflow definition object.
 * Throws with a descriptive error if invalid.
 */
export function validateWorkflow(raw: unknown, sourceId?: string): WorkflowDefinition {
  const id = sourceId || 'unknown';
  
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Workflow ${id}: must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  
  if (typeof obj.id !== 'string') throw new Error(`Workflow ${id}: missing string field 'id'`);
  if (typeof obj.name !== 'string') throw new Error(`Workflow ${id}: missing string field 'name'`);
  if (!Array.isArray(obj.nodes)) throw new Error(`Workflow ${id}: 'nodes' must be an array`);
  if (!Array.isArray(obj.edges)) throw new Error(`Workflow ${id}: 'edges' must be an array`);
  
  const nodes = obj.nodes as WorkflowNode[];
  const edges = obj.edges as WorkflowEdge[];
  
  for (const node of nodes) {
    if (!node.id) throw new Error(`Workflow ${id}: node missing 'id'`);
    if (!node.type) throw new Error(`Workflow ${id}: node ${node.id} missing 'type'`);
    if (!node.name) throw new Error(`Workflow ${id}: node ${node.id} missing 'name'`);
  }
  
  for (const edge of edges) {
    if (!edge.from) throw new Error(`Workflow ${id}: edge missing 'from'`);
    if (!edge.to) throw new Error(`Workflow ${id}: edge missing 'to'`);
    if (typeof edge.from_output !== 'number') edge.from_output = 0;
  }
  
  return {
    id: obj.id as string,
    name: obj.name as string,
    description: obj.description as string | undefined,
    version: obj.version as string | undefined,
    nodes,
    edges,
  };
}
