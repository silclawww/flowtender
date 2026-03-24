import type { WorkflowDefinition } from '@/types/workflow';

export type NodeStatus = 'pending' | 'running' | 'done' | 'error';

/**
 * Convert a workflow definition to a Mermaid flowchart string.
 * Optionally highlight nodes based on their execution status.
 */
export function workflowToMermaid(
  workflow: WorkflowDefinition,
  nodeStatuses?: Record<string, NodeStatus>
): string {
  const lines: string[] = ['flowchart LR'];

  // Add nodes with status styling
  for (const node of workflow.nodes) {
    const status = nodeStatuses?.[node.id];
    // Escape quotes and newlines in labels
    const escapedName = node.name.replace(/"/g, '#quot;');
    const escapedType = node.type.replace(/"/g, '#quot;');
    const label = `${escapedName}<br/>[${escapedType}]`;

    if (status === 'done') {
      lines.push(`  ${node.id}["${label}"]:::done`);
    } else if (status === 'error') {
      lines.push(`  ${node.id}["${label}"]:::error`);
    } else if (status === 'running') {
      lines.push(`  ${node.id}["${label}"]:::running`);
    } else {
      lines.push(`  ${node.id}["${label}"]`);
    }
  }

  // Add edges
  for (const edge of workflow.edges) {
    lines.push(`  ${edge.from} --> ${edge.to}`);
  }

  // Style classes
  lines.push('  classDef done fill:#d1fae5,stroke:#065f46,color:#065f46');
  lines.push('  classDef error fill:#fee2e2,stroke:#991b1b,color:#991b1b');
  lines.push('  classDef running fill:#fef3c7,stroke:#92400e,color:#92400e');

  return lines.join('\n');
}
