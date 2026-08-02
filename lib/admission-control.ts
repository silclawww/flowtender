export type PipelineOperation = 'upload' | 'stage2' | 'stage3' | 'retry';

type RpcResult = { data: unknown; error: unknown };
export type AdmissionRpcClient = unknown;

type AdmissionRow = {
  allowed?: unknown;
  reason?: unknown;
  lease_id?: unknown;
};

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

function firstRow(data: unknown): AdmissionRow | null {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === 'object' ? value as AdmissionRow : null;
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

  const row = firstRow(result.data);
  if (result.error || !row) {
    throw new AdmissionControlError(503, 'ADMISSION_UNAVAILABLE');
  }
  if (row.allowed !== true) {
    if (row.reason === 'invalid_context') {
      throw new AdmissionControlError(503, 'ADMISSION_UNAVAILABLE');
    }
    throw new AdmissionControlError(429, 'PIPELINE_LIMITED');
  }
  if (typeof row.lease_id !== 'string' || !row.lease_id) {
    throw new AdmissionControlError(503, 'ADMISSION_UNAVAILABLE');
  }
  return row.lease_id;
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
    operation: 'stage2' | 'stage3' | 'retry';
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
