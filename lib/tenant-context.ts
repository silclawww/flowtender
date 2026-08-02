const TENANT_SCOPED_WORKFLOWS = new Set([
  'tender-stage2-requirements',
  'tender-stage3-evaluation',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TenantContext {
  tender_id: string;
  org_id: string;
  user_id: string;
  admission_id: string;
}

interface WorkflowPayloadPreflight {
  payload: Record<string, unknown>;
  tenantContext: TenantContext | null;
}

function invalidTenantContext(): never {
  throw new Error('INVALID_TENANT_CONTEXT');
}

function optionalUuid(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalidTenantContext();
  return value.toLowerCase();
}

function canonicalUuid(
  directValue: unknown,
  wrappedValue: unknown,
): string {
  const direct = optionalUuid(directValue);
  const wrapped = optionalUuid(wrappedValue);
  if (direct && wrapped && direct !== wrapped) invalidTenantContext();
  return wrapped ?? direct ?? invalidTenantContext();
}

export function preflightWorkflowPayload(
  workflowId: string,
  payload: unknown,
): WorkflowPayloadPreflight {
  if (!TENANT_SCOPED_WORKFLOWS.has(workflowId)) {
    return { payload: payload as Record<string, unknown>, tenantContext: null };
  }

  const root = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  if (!root) invalidTenantContext();

  const nestedBody = root.body;
  const wrapped = nestedBody && typeof nestedBody === 'object' && !Array.isArray(nestedBody)
    ? nestedBody as Record<string, unknown>
    : null;

  const tenantContext = {
    tender_id: canonicalUuid(root.tender_id, wrapped?.tender_id),
    org_id: canonicalUuid(root.org_id, wrapped?.org_id),
    user_id: canonicalUuid(root.user_id, wrapped?.user_id),
    admission_id: canonicalUuid(root.admission_id, wrapped?.admission_id),
  };
  return { payload: tenantContext, tenantContext };
}
