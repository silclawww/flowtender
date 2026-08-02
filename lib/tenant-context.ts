const TENANT_SCOPED_WORKFLOWS = new Set([
  'tender-stage2-requirements',
  'tender-stage3-evaluation',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireWorkflowTenantContext(
  workflowId: string,
  payload: unknown,
): void {
  if (!TENANT_SCOPED_WORKFLOWS.has(workflowId)) return;

  const root = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  if (!root) throw new Error('INVALID_TENANT_CONTEXT');

  const nestedBody = root.body;
  const body = nestedBody && typeof nestedBody === 'object' && !Array.isArray(nestedBody)
    ? nestedBody as Record<string, unknown>
    : root;

  if (typeof body.tender_id !== 'string'
    || !UUID_PATTERN.test(body.tender_id)
    || typeof body.org_id !== 'string'
    || !UUID_PATTERN.test(body.org_id)) {
    throw new Error('INVALID_TENANT_CONTEXT');
  }
}
