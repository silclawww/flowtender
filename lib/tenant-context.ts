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
export const CERTIFICATE_CATALOGUE_PROJECTION_MAX_BYTES = 16 * 1024;
export const CERTIFICATE_CATALOGUE_PROMPT_PREFIX =
  'ZERTIFIKATSKATALOG (serverseitige Daten-Allowlist): \n';
export const CERTIFICATE_CATALOGUE_PROMPT_MAX_ESTIMATED_TOKENS = 2_400;

export interface TrustedAdmissionContext {
  tender_id: string;
  org_id: string;
  user_id: string;
  admission_id: string;
  operation: AdmissionOperation;
  evaluation_reason?: 'evidence_changes';
}

type EvidenceStatus = 'pending' | 'in_progress' | 'verified' | 'not_met';

type EvidenceFields = {
  evidence_id: string;
  title: string;
  category: string;
  status: EvidenceStatus;
  note: string | null;
  cert_reference: string | null;
  cert_expiry: string | null;
  updated_at: string;
};

export type CompanyRequirementEvidence = EvidenceFields & {
  legacy_identity: true;
};

export type TenderRequirementEvidence = EvidenceFields & {
  requirement_id: string;
  status: EvidenceStatus | 'not_applicable';
};

export interface WorkflowPayloadPreflight {
  source: Record<string, unknown>;
  trustedContext: TrustedAdmissionContext | null;
  certificateCatalogue?: CertificateCatalogueProjection;
  companyRequirementEvidence?: CompanyRequirementEvidence[];
  tenderRequirementEvidence?: TenderRequirementEvidence[];
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

export interface CertificateCatalogueProjection {
  version: string;
  entries: Array<{
    id: string;
    code: string;
    name_de: string;
    name_en: string;
    aliases: string[];
  }>;
}

export interface CertificateCataloguePromptTokenMeasurement {
  estimatedTokens: number;
  safeUpperBoundTokens: number;
  utf8Bytes: number;
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

function requiredString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    ? value : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function catalogueString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length > maxLength) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Deterministic measurement of the exact prompt block. No local Gemini
 * tokenizer is available, so UTF-8/4 plus one per non-ASCII code point tracks
 * expected cost while the byte count is a tokenizer-independent safe upper
 * bound for arbitrary UTF-8 input.
 */
export function measureCertificateCataloguePromptTokens(
  promptBlock: string,
): CertificateCataloguePromptTokenMeasurement {
  const bytes = utf8Bytes(promptBlock);
  const nonAsciiCodePoints = [...promptBlock]
    .filter((character) => (character.codePointAt(0) ?? 0) > 0x7f)
    .length;
  return {
    estimatedTokens: Math.ceil(bytes / 4) + nonAsciiCodePoints,
    safeUpperBoundTokens: bytes,
    utf8Bytes: bytes,
  };
}

function assertCertificateCataloguePromptBudget(promptBlock: string): void {
  const measurement = measureCertificateCataloguePromptTokens(promptBlock);
  if (measurement.estimatedTokens > CERTIFICATE_CATALOGUE_PROMPT_MAX_ESTIMATED_TOKENS
    || measurement.safeUpperBoundTokens > CERTIFICATE_CATALOGUE_PROJECTION_MAX_BYTES) invalidPayload();
}

export function certificateCatalogueProjection(value: unknown): CertificateCatalogueProjection | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || !exactKeys(value, ['version', 'entries'])) invalidPayload();
  const version = catalogueString(dataProperty(value, 'version'), 32);
  const rawEntries = dataProperty(value, 'entries');
  if (!version || !Array.isArray(rawEntries) || rawEntries.length > 60) invalidPayload();
  const seen = new Set<string>();
  const entries = rawEntries.map((raw) => {
    if (!isPlainObject(raw)
      || !exactKeys(raw, ['id', 'code', 'name_de', 'name_en', 'aliases'])) invalidPayload();
    const id = catalogueString(dataProperty(raw, 'id'), 64);
    const code = catalogueString(dataProperty(raw, 'code'), 40);
    const nameDe = catalogueString(dataProperty(raw, 'name_de'), 80);
    const nameEn = catalogueString(dataProperty(raw, 'name_en'), 80);
    const rawAliases = dataProperty(raw, 'aliases');
    if (!id || !code || !nameDe || !nameEn || seen.has(id)
      || !Array.isArray(rawAliases) || rawAliases.length > 4) invalidPayload();
    const aliases = [...new Set(rawAliases.map((alias) => catalogueString(alias, 60)))];
    if (aliases.some((alias) => alias === undefined)) invalidPayload();
    seen.add(id);
    return { id, code, name_de: nameDe, name_en: nameEn, aliases: aliases as string[] };
  });
  const projection = { version, entries };
  assertCertificateCataloguePromptBudget(
    CERTIFICATE_CATALOGUE_PROMPT_PREFIX + JSON.stringify(projection),
  );
  return projection;
}

function evidenceFields(
  raw: Record<string, unknown>,
  statusOverride?: EvidenceStatus,
): EvidenceFields | undefined {
  const evidenceId = requiredString(dataProperty(raw, 'evidence_id'), 100);
  const title = requiredString(dataProperty(raw, 'title'), 500);
  const category = requiredString(dataProperty(raw, 'category'), 200);
  const status = statusOverride ?? dataProperty(raw, 'status');
  const note = nullableString(dataProperty(raw, 'note'), 2000);
  const certReference = nullableString(dataProperty(raw, 'cert_reference'), 500);
  const certExpiry = nullableString(dataProperty(raw, 'cert_expiry'), 10);
  const updatedAt = dataProperty(raw, 'updated_at');
  if (!evidenceId || !title || !category
    || typeof status !== 'string'
    || !['pending', 'in_progress', 'verified', 'not_met'].includes(status)
    || note === undefined || certReference === undefined || certExpiry === undefined
    || typeof updatedAt !== 'string' || updatedAt.length > 40
    || !Number.isFinite(Date.parse(updatedAt))) return undefined;
  return {
    evidence_id: evidenceId,
    title,
    category,
    status: status as EvidenceStatus,
    note,
    cert_reference: certReference,
    cert_expiry: certExpiry,
    updated_at: updatedAt,
  };
}

export function companyRequirementEvidence(value: unknown): CompanyRequirementEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) invalidPayload();
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!isPlainObject(raw)
      || Object.keys(raw).sort().join(',')
        !== 'category,cert_expiry,cert_reference,evidence_id,legacy_identity,note,status,title,updated_at') {
      invalidPayload();
    }
    const parsed = evidenceFields(raw);
    if (!parsed || dataProperty(raw, 'legacy_identity') !== true || seen.has(parsed.evidence_id)) invalidPayload();
    seen.add(parsed.evidence_id);
    return { ...parsed, legacy_identity: true };
  });
}

export function tenderRequirementEvidence(value: unknown): TenderRequirementEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 25) invalidPayload();
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!isPlainObject(raw)
      || Object.keys(raw).sort().join(',')
        !== 'category,cert_expiry,cert_reference,evidence_id,note,requirement_id,status,title,updated_at') {
      invalidPayload();
    }
    const requirementId = dataProperty(raw, 'requirement_id');
    const status = dataProperty(raw, 'status');
    const parsed = evidenceFields(raw, status === 'not_applicable' ? 'pending' : undefined);
    if (!parsed || typeof requirementId !== 'string'
      || requirementId.trim().length === 0 || requirementId.length > 100
      || seen.has(requirementId)
      || typeof status !== 'string'
      || !['pending', 'in_progress', 'verified', 'not_met', 'not_applicable'].includes(status)
      || (status === 'not_applicable' && !parsed.note?.trim())) invalidPayload();
    seen.add(requirementId);
    return {
      ...parsed,
      requirement_id: requirementId,
      status: status as TenderRequirementEvidence['status'],
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
  const companyEvidenceValue = dataProperty(businessSource, 'company_requirement_evidence');
  const tenderEvidenceValue = dataProperty(businessSource, 'tender_requirement_evidence');
  const certificateCatalogueValue = dataProperty(businessSource, 'certificate_catalogue');
  if ((companyEvidenceValue !== undefined || tenderEvidenceValue !== undefined) && operation !== 'stage3') {
    invalidPayload();
  }
  if (certificateCatalogueValue !== undefined && operation !== 'stage2') invalidPayload();
  const certificateCatalogue = operation === 'stage2'
    ? certificateCatalogueProjection(certificateCatalogueValue) : undefined;
  const companyEvidence = operation === 'stage3'
    ? companyRequirementEvidence(companyEvidenceValue) : undefined;
  const tenderEvidence = operation === 'stage3'
    ? tenderRequirementEvidence(tenderEvidenceValue) : undefined;
  const trustedContext: TrustedAdmissionContext = {
    tender_id: canonicalUuid(dataProperty(root, 'tender_id'), wrapped ? dataProperty(wrapped, 'tender_id') : undefined),
    org_id: canonicalUuid(dataProperty(root, 'org_id'), wrapped ? dataProperty(wrapped, 'org_id') : undefined),
    user_id: canonicalUuid(dataProperty(root, 'user_id'), wrapped ? dataProperty(wrapped, 'user_id') : undefined),
    admission_id: canonicalUuid(dataProperty(root, 'admission_id'), wrapped ? dataProperty(wrapped, 'admission_id') : undefined),
    operation,
    ...(reason ? { evaluation_reason: reason } : {}),
  };
  return {
    source: businessSource,
    trustedContext,
    certificateCatalogue,
    companyRequirementEvidence: companyEvidence,
    tenderRequirementEvidence: tenderEvidence,
  };
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
        ...(context.operation === 'stage2' && preflight.certificateCatalogue
          ? { certificate_catalogue: preflight.certificateCatalogue } : {}),
        ...(context.operation === 'stage3' && preflight.companyRequirementEvidence
          ? { company_requirement_evidence: preflight.companyRequirementEvidence } : {}),
        ...(context.operation === 'stage3' && preflight.tenderRequirementEvidence
          ? { tender_requirement_evidence: preflight.tenderRequirementEvidence } : {}),
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
