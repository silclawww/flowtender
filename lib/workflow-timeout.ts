export function workflowTimeoutOptions(workflowId: string): { timeoutMs: number } | Record<string, never> {
  return workflowId === 'tender-stage2-requirements' ? { timeoutMs: 270_000 } : {};
}
