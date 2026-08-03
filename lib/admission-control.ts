export type PipelineOperation = 'upload' | 'stage2' | 'stage3' | 'retry';

type RpcResult = { data: unknown; error: unknown };
export type AdmissionRpcClient = unknown;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT_REASONS = new Set([
  'user_concurrency',
  'org_concurrency',
  'user_rate',
  'org_rate',
  'retry_ceiling',
]);
const CONTEXT_REASONS = new Set(['invalid_context', 'retry_context_mismatch']);

type CanonicalAdmission =
  | { allowed: true; reason: null; leaseId: string }
  | { allowed: false; reason: string; leaseId: null };

export class AdmissionControlError extends Error {
  readonly status: 429 | 503;
  readonly code: 'PIPELINE_LIMITED' | 'ADMISSION_UNAVAILABLE';

  constructor(
    status: 429 | 503,
    code: 'PIPELINE_LIMITED' | 'ADMISSION_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'AdmissionControlError';
    this.status = status;
    this.code = code;
  }
}

function parseAdmission(data: unknown): CanonicalAdmission | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  const row = data[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'allowed,lease_id,reason') return null;
  if (record.allowed === true
    && record.reason === null
    && typeof record.lease_id === 'string'
    && UUID_PATTERN.test(record.lease_id)) {
    return { allowed: true, reason: null, leaseId: record.lease_id.toLowerCase() };
  }
  if (record.allowed === false
    && typeof record.reason === 'string'
    && record.lease_id === null
    && (LIMIT_REASONS.has(record.reason) || CONTEXT_REASONS.has(record.reason))) {
    return { allowed: false, reason: record.reason, leaseId: null };
  }
  return null;
}

function callRpc(
  client: AdmissionRpcClient,
  name: string,
  args: Record<string, unknown>,
): PromiseLike<RpcResult> {
  return (client as {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
  }).rpc(name, args);
}

export async function acquirePipelineAdmission(
  client: AdmissionRpcClient,
  input: {
    actorUserId: string;
    orgId: string;
    operation: PipelineOperation;
    retryRootExecutionId?: string | null;
  },
): Promise<string> {
  let result: RpcResult;
  try {
    result = await callRpc(client, 'acquire_pipeline_admission', {
      p_actor_user_id: input.actorUserId,
      p_org_id: input.orgId,
      p_operation: input.operation,
      p_retry_root_execution_id: input.retryRootExecutionId ?? null,
    });
  } catch {
    throw new AdmissionControlError(503, 'ADMISSION_UNAVAILABLE');
  }

  const row = parseAdmission(result.data);
  if (result.error || !row) {
    throw new AdmissionControlError(503, 'ADMISSION_UNAVAILABLE');
  }
  if (!row.allowed) {
    if (CONTEXT_REASONS.has(row.reason)) {
      throw new AdmissionControlError(503, 'ADMISSION_UNAVAILABLE');
    }
    throw new AdmissionControlError(429, 'PIPELINE_LIMITED');
  }
  return row.leaseId;
}

export async function releasePipelineAdmission(
  client: AdmissionRpcClient,
  leaseId: string,
): Promise<boolean> {
  try {
    const { data, error } = await callRpc(client, 'release_pipeline_admission', {
      p_lease_id: leaseId,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function claimPipelineAdmission(
  client: AdmissionRpcClient,
  input: {
    leaseId: string;
    actorUserId: string;
    orgId: string;
    operation: 'upload' | 'stage2' | 'stage3' | 'retry';
    rootExecutionId: string;
  },
): Promise<void> {
  try {
    const { data, error } = await callRpc(client, 'claim_pipeline_admission', {
      p_lease_id: input.leaseId,
      p_actor_user_id: input.actorUserId,
      p_org_id: input.orgId,
      p_operation: input.operation,
      p_root_execution_id: input.rootExecutionId,
    });
    if (error || data !== true) throw new Error('claim denied');
  } catch {
    throw new AdmissionControlError(503, 'ADMISSION_UNAVAILABLE');
  }
}
