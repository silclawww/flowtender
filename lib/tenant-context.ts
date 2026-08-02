import { AdmissionControlError } from './admission-control.ts';

export type AdmissionOperation = 'upload' | 'stage2' | 'stage3';

const WORKFLOW_OPERATIONS = new Map<string, AdmissionOperation>([
  ['tender-stage1-pdf', 'upload'],
  ['tender-stage1-gaeb', 'upload'],
  ['tender-stage2-requirements', 'stage2'],
  ['tender-stage3-evaluation', 'stage3'],
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRUSTED_ONLY_KEYS = new Set(['user_id', 'admission_id']);

export interface TrustedAdmissionContext {
  tender_id: string;
  org_id: string;
  user_id: string;
  admission_id: string;
  operation: AdmissionOperation;
}

interface WorkflowPayloadPreflight {
  payload: Record<string, unknown>;
  trustedContext: TrustedAdmissionContext | null;
}

function invalidTenantContext(): never {
  throw new AdmissionControlError(503, 'ADMISSION_UNAVAILABLE');
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

function stripTrustedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTrustedFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !TRUSTED_ONLY_KEYS.has(key) && key !== 'body')
      .map(([key, nested]) => [key, stripTrustedFields(nested)]),
  );
}

export function preflightWorkflowPayload(
  workflowId: string,
  payload: unknown,
): WorkflowPayloadPreflight {
  const operation = WORKFLOW_OPERATIONS.get(workflowId);
  if (!operation) {
    return { payload: payload as Record<string, unknown>, trustedContext: null };
  }

  const root = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  if (!root) invalidTenantContext();

  const nestedBody = root.body;
  const wrapped = nestedBody && typeof nestedBody === 'object' && !Array.isArray(nestedBody)
    ? nestedBody as Record<string, unknown>
    : null;

  const trustedContext: TrustedAdmissionContext = {
    tender_id: canonicalUuid(root.tender_id, wrapped?.tender_id),
    org_id: canonicalUuid(root.org_id, wrapped?.org_id),
    user_id: canonicalUuid(root.user_id, wrapped?.user_id),
    admission_id: canonicalUuid(root.admission_id, wrapped?.admission_id),
    operation,
  };

  if (operation !== 'upload') {
    return {
      payload: { tender_id: trustedContext.tender_id, org_id: trustedContext.org_id },
      trustedContext,
    };
  }

  const source = stripTrustedFields(wrapped ?? root) as Record<string, unknown>;
  return {
    payload: {
      ...source,
      tender_id: trustedContext.tender_id,
      org_id: trustedContext.org_id,
    },
    trustedContext,
  };
}
