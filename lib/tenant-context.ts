import { AdmissionControlError } from './admission-control.ts';

export type AdmissionOperation = 'upload' | 'stage2' | 'stage3';

const WORKFLOW_OPERATIONS = new Map<string, AdmissionOperation>([
  ['tender-stage1', 'upload'],
  ['tender-stage1-pdf', 'upload'],
  ['tender-stage1-gaeb', 'upload'],
  ['tender-stage2-requirements', 'stage2'],
  ['tender-stage3-evaluation', 'stage3'],
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRUSTED_ONLY_KEYS = new Set(['user_id', 'admission_id']);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const WORKFLOW_PAYLOAD_MAX_DEPTH = 64;
export const WORKFLOW_PAYLOAD_MAX_NODES = 250_000;
export const WORKFLOW_PAYLOAD_MAX_BYTES = 75 * 1024 * 1024;

export interface TrustedAdmissionContext {
  tender_id: string;
  org_id: string;
  user_id: string;
  admission_id: string;
  operation: AdmissionOperation;
  evaluation_reason?: 'evidence_changes';
}

type RequirementEvidence = {
  requirement_id: string;
  status: 'pending' | 'in_progress' | 'verified' | 'not_applicable';
  note: string | null;
  cert_reference: string | null;
  cert_expiry: string | null;
  updated_at: string;
};

export interface WorkflowPayloadPreflight {
  source: Record<string, unknown>;
  trustedContext: TrustedAdmissionContext | null;
  requirementEvidence?: RequirementEvidence[];
}

export interface MaterializedWorkflowPayload {
  workflowId: string;
  payload: Record<string, unknown>;
}

interface PayloadLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxBytes?: number;
}

export class WorkflowPayloadError extends Error {
  readonly code = 'INVALID_WORKFLOW_PAYLOAD';

  constructor() {
    super('INVALID_WORKFLOW_PAYLOAD');
    this.name = 'WorkflowPayloadError';
  }
}

function invalidTenantContext(): never {
  throw new AdmissionControlError(503, 'ADMISSION_UNAVAILABLE');
}

function invalidPayload(): never {
  throw new WorkflowPayloadError();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) invalidTenantContext();
  return descriptor.value;
}

function optionalUuid(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalidTenantContext();
  return value.toLowerCase();
}

function canonicalUuid(directValue: unknown, wrappedValue: unknown): string {
  const direct = optionalUuid(directValue);
  const wrapped = optionalUuid(wrappedValue);
  if (direct && wrapped && direct !== wrapped) invalidTenantContext();
  return wrapped ?? direct ?? invalidTenantContext();
}

function evaluationReason(directValue: unknown, wrappedValue: unknown): 'evidence_changes' | undefined {
  const direct = directValue === undefined ? undefined
    : directValue === 'evidence_changes' ? directValue : invalidPayload();
  const wrapped = wrappedValue === undefined ? undefined
    : wrappedValue === 'evidence_changes' ? wrappedValue : invalidPayload();
  if (direct && wrapped && direct !== wrapped) invalidPayload();
  return wrapped ?? direct;
}

function nullableString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function requirementEvidence(value: unknown): RequirementEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 25) invalidPayload();
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!isPlainObject(raw)
      || Object.keys(raw).sort().join(',')
        !== 'cert_expiry,cert_reference,note,requirement_id,status,updated_at') invalidPayload();
    const requirementId = dataProperty(raw, 'requirement_id');
    const status = dataProperty(raw, 'status');
    const note = nullableString(dataProperty(raw, 'note'), 2000);
    const certReference = nullableString(dataProperty(raw, 'cert_reference'), 500);
    const certExpiry = nullableString(dataProperty(raw, 'cert_expiry'), 10);
    const updatedAt = dataProperty(raw, 'updated_at');
    if (typeof requirementId !== 'string'
      || requirementId.length === 0
      || requirementId.length > 100
      || seen.has(requirementId)
      || typeof status !== 'string'
      || !['pending', 'in_progress', 'verified', 'not_applicable'].includes(status)
      || note === undefined
      || certReference === undefined
      || certExpiry === undefined
      || typeof updatedAt !== 'string'
      || !Number.isFinite(Date.parse(updatedAt))) invalidPayload();
    seen.add(requirementId);
    return {
      requirement_id: requirementId,
      status: status as RequirementEvidence['status'],
      note,
      cert_reference: certReference,
      cert_expiry: certExpiry,
      updated_at: updatedAt,
    };
  });
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function boundedClone(
  source: unknown,
  stripTrustedFields: boolean,
  limits: PayloadLimits = {},
): unknown {
  const maxDepth = limits.maxDepth ?? WORKFLOW_PAYLOAD_MAX_DEPTH;
  const maxNodes = limits.maxNodes ?? WORKFLOW_PAYLOAD_MAX_NODES;
  const maxBytes = limits.maxBytes ?? WORKFLOW_PAYLOAD_MAX_BYTES;
  let nodes = 0;
  let bytes = 0;
  const seen = new WeakSet<object>();

  const account = (value: unknown): void => {
    nodes += 1;
    if (nodes > maxNodes) invalidPayload();
    if (typeof value === 'string') bytes += utf8Bytes(value);
    else if (typeof value === 'number') bytes += 8;
    else if (typeof value === 'boolean') bytes += value ? 4 : 5;
    else if (value === null) bytes += 4;
    if (bytes > maxBytes) invalidPayload();
  };

  const primitive = (value: unknown): unknown => {
    if (value === null
      || typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean') {
      if (typeof value === 'number' && !Number.isFinite(value)) invalidPayload();
      account(value);
      return value;
    }
    invalidPayload();
  };

  if (!source || typeof source !== 'object') return primitive(source);
  const root = Array.isArray(source) ? [] : {};
  const stack: Array<{ input: object; output: unknown[] | Record<string, unknown>; depth: number }> = [
    { input: source, output: root, depth: 0 },
  ];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.depth > maxDepth) invalidPayload();
    if (seen.has(frame.input)) invalidPayload();
    seen.add(frame.input);
    account(frame.input);

    const isArray = Array.isArray(frame.input);
    if (!isArray && !isPlainObject(frame.input)) invalidPayload();
    const descriptors = Object.getOwnPropertyDescriptors(frame.input);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') invalidPayload();
      if (isArray && key === 'length') continue;
      if (DANGEROUS_KEYS.has(key)) invalidPayload();
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor)) invalidPayload();
      if (stripTrustedFields && TRUSTED_ONLY_KEYS.has(key)) continue;
      bytes += utf8Bytes(key);
      if (bytes > maxBytes) invalidPayload();

      const value = descriptor.value;
      if (value && typeof value === 'object') {
        const child = Array.isArray(value) ? [] : {};
        if (Array.isArray(frame.output)) {
          if (!/^\d+$/.test(key)) invalidPayload();
          frame.output[Number(key)] = child;
        } else {
          frame.output[key] = child;
        }
        stack.push({ input: value, output: child, depth: frame.depth + 1 });
      } else {
        const cloned = primitive(value);
        if (Array.isArray(frame.output)) {
          if (!/^\d+$/.test(key)) invalidPayload();
          frame.output[Number(key)] = cloned;
        } else {
          frame.output[key] = cloned;
        }
      }
    }
  }
  return root;
}

export function preflightWorkflowPayload(
  workflowId: string,
  payload: unknown,
  configuredAllowedOrgId = process.env.FLOWTENDER_ALLOWED_ORG_ID,
  configuredVercelEnvironment = process.env.VERCEL_ENV,
): WorkflowPayloadPreflight {
  const operation = WORKFLOW_OPERATIONS.get(workflowId);
  const root = isPlainObject(payload) ? payload : null;
  if (!root) {
    if (operation) invalidTenantContext();
    invalidPayload();
  }
  if (!operation) return { source: root, trustedContext: null };

  const bodyValue = dataProperty(root, 'body');
  const wrapped = bodyValue === undefined ? null : isPlainObject(bodyValue) ? bodyValue : invalidTenantContext();
  const reason = evaluationReason(
    dataProperty(root, 'evaluation_reason'),
    wrapped ? dataProperty(wrapped, 'evaluation_reason') : undefined,
  );
  if (reason && operation !== 'stage3') invalidPayload();
  const businessSource = wrapped ?? root;
  const evidenceValue = dataProperty(businessSource, 'requirement_evidence');
  if (evidenceValue !== undefined && operation !== 'stage3') invalidPayload();
  const evidence = operation === 'stage3' ? requirementEvidence(evidenceValue) : undefined;
  const trustedContext: TrustedAdmissionContext = {
    tender_id: canonicalUuid(dataProperty(root, 'tender_id'), wrapped ? dataProperty(wrapped, 'tender_id') : undefined),
    org_id: canonicalUuid(dataProperty(root, 'org_id'), wrapped ? dataProperty(wrapped, 'org_id') : undefined),
    user_id: canonicalUuid(dataProperty(root, 'user_id'), wrapped ? dataProperty(wrapped, 'user_id') : undefined),
    admission_id: canonicalUuid(dataProperty(root, 'admission_id'), wrapped ? dataProperty(wrapped, 'admission_id') : undefined),
    operation,
    ...(reason ? { evaluation_reason: reason } : {}),
  };
  const allowedOrgId = configuredAllowedOrgId?.trim().toLowerCase();
  if (configuredVercelEnvironment === 'preview' && !allowedOrgId) invalidTenantContext();
  if (allowedOrgId && trustedContext.org_id !== allowedOrgId) invalidTenantContext();
  return { source: businessSource, trustedContext, requirementEvidence: evidence };
}

export function materializeWorkflowPayload(
  workflowId: string,
  preflight: WorkflowPayloadPreflight,
  limits: PayloadLimits = {},
): MaterializedWorkflowPayload {
  const context = preflight.trustedContext;
  if (!context) {
    const payload = boundedClone(preflight.source, false, limits);
    if (!isPlainObject(payload)) invalidPayload();
    return { workflowId, payload };
  }
  if (context.operation !== 'upload') {
    return {
      workflowId,
      payload: {
        tender_id: context.tender_id,
        org_id: context.org_id,
        ...(context.operation === 'stage3' && preflight.requirementEvidence
          ? { requirement_evidence: preflight.requirementEvidence }
          : {}),
      },
    };
  }

  const cloned = boundedClone(preflight.source, true, limits);
  if (!isPlainObject(cloned)) invalidPayload();
  const payload: Record<string, unknown> = {
    ...cloned,
    tender_id: context.tender_id,
    org_id: context.org_id,
  };
  if (workflowId !== 'tender-stage1') return { workflowId, payload };
  const fileType = payload.file_type;
  if (fileType === 'pdf') return { workflowId: 'tender-stage1-pdf', payload };
  if (fileType === 'gaeb' || fileType === 'archive') {
    return { workflowId: 'tender-stage1-gaeb', payload };
  }
  invalidPayload();
}
