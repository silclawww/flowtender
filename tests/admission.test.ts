import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquirePipelineAdmission,
  AdmissionControlError,
  claimPipelineAdmission,
  releasePipelineAdmission,
} from '../lib/admission-control.ts';

const actorId = 'aaaaaaaa-0000-4000-8000-000000000001';
const orgId = 'bbbbbbbb-0000-4000-8000-000000000001';
const rootId = 'cccccccc-0000-4000-8000-000000000001';
const leaseId = 'dddddddd-0000-4000-8000-000000000001';

test('retry admission forwards immutable actor, org, and root execution metadata', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { data: [{ allowed: true, reason: null, lease_id: leaseId }], error: null };
    },
  };

  assert.equal(await acquirePipelineAdmission(client, {
    actorUserId: actorId,
    orgId,
    operation: 'retry',
    retryRootExecutionId: rootId,
  }), leaseId);
  assert.deepEqual(calls[0], {
    name: 'acquire_pipeline_admission',
    args: {
      p_actor_user_id: actorId,
      p_org_id: orgId,
      p_operation: 'retry',
      p_retry_root_execution_id: rootId,
    },
  });
});

test('limiter denial and failures fail closed without raw errors', async () => {
  for (const fixture of [
    {
      result: { data: [{ allowed: false, reason: 'retry_ceiling', lease_id: null }], error: null },
      status: 429,
      code: 'PIPELINE_LIMITED',
    },
    {
      result: { data: null, error: { message: 'database host leaked' } },
      status: 503,
      code: 'ADMISSION_UNAVAILABLE',
    },
  ]) {
    await assert.rejects(
      acquirePipelineAdmission({ rpc: async () => fixture.result }, {
        actorUserId: actorId,
        orgId,
        operation: 'retry',
        retryRootExecutionId: rootId,
      }),
      (error: unknown) => {
        assert.equal(error instanceof AdmissionControlError, true);
        assert.equal((error as AdmissionControlError).status, fixture.status);
        assert.equal((error as AdmissionControlError).code, fixture.code);
        assert.doesNotMatch(String(error), /database host leaked/);
        return true;
      },
    );
  }
});

test('release is safe and bounded when the database is unavailable', async () => {
  assert.equal(await releasePipelineAdmission({
    rpc: async () => ({ data: true, error: null }),
  }, leaseId), true);
  assert.equal(await releasePipelineAdmission({
    rpc: async () => { throw new Error('database host leaked'); },
  }, leaseId), false);
});

test('a workflow must atomically claim its matching lease before execution', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  await claimPipelineAdmission({
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { data: true, error: null };
    },
  }, {
    leaseId,
    actorUserId: actorId,
    orgId,
    operation: 'stage2',
    rootExecutionId: rootId,
  });
  assert.deepEqual(calls, [{
    name: 'claim_pipeline_admission',
    args: {
      p_lease_id: leaseId,
      p_actor_user_id: actorId,
      p_org_id: orgId,
      p_operation: 'stage2',
      p_root_execution_id: rootId,
    },
  }]);

  await assert.rejects(
    claimPipelineAdmission({ rpc: async () => ({ data: false, error: null }) }, {
      leaseId,
      actorUserId: actorId,
      orgId,
      operation: 'stage2',
      rootExecutionId: rootId,
    }),
    (error: unknown) => error instanceof AdmissionControlError
      && error.status === 503
      && error.code === 'ADMISSION_UNAVAILABLE',
  );
});
