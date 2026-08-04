import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkflowRunner } from '../lib/runner/runner.ts';
import type { NodeType, WorkflowDefinition } from '../types/workflow.ts';

const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';
const orgId = '3edb0931-87a3-45a6-a8f1-c1e87d539596';
const actorId = 'fca2e00f-80ad-4c6c-afbb-392cf49eb7b6';
const admissionId = 'c2b37af4-c299-4db7-859f-8423c3230d70';

function recordingClient() {
  const inserts: Array<{ table: string; value: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; value: Record<string, unknown> }> = [];
  const rpcs: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const mutation = {
    eq() { return mutation; },
    async select() { return { data: [{}], error: null }; },
  };

  return {
    inserts,
    updates,
    rpcs,
    client: {
      async rpc(name: string, parameters: Record<string, unknown>) {
        rpcs.push({ name, parameters });
        if (name === 'claim_tender_processing_stage') {
          return { data: [{ claimed: true, reason: null, processing_status: 'evaluating' }], error: null };
        }
        if (name === 'record_tender_processing_failure') {
          return {
            data: [{ tender_id: tenderId, org_id: orgId, affected_count: 1, processing_attempt_count: 1 }],
            error: null,
          };
        }
        return { data: true, error: null };
      },
      from(table: string) {
        return {
          insert(value: Record<string, unknown>) {
            inserts.push({ table, value });
            return mutation;
          },
          update(value: Record<string, unknown>) {
            updates.push({ table, value });
            return mutation;
          },
        };
      },
    },
  };
}

function oneNodeWorkflow(
  type: NodeType,
  config: Record<string, unknown>,
): WorkflowDefinition {
  return {
    id: 'tender-stage3-evaluation',
    name: 'Deadline guard',
    nodes: [{ id: 'stalled-node', name: 'Stalled node', type, config }],
    edges: [],
  };
}

async function runWithDeadline(
  type: NodeType,
  config: Record<string, unknown>,
  timeoutMs = 25,
) {
  const database = recordingClient();
  const runner = new WorkflowRunner(
    database.client as never,
    () => oneNodeWorkflow(type, config),
  );
  let guard: ReturnType<typeof setTimeout> | undefined;
  const run = runner.run('tender-stage3-evaluation', {
    tender_id: tenderId,
    org_id: orgId,
    user_id: actorId,
    admission_id: admissionId,
  }, { timeoutMs });
  const result = await Promise.race([
    run,
    new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => reject(new Error('runner did not honor its deadline')), 500);
    }),
  ]).finally(() => clearTimeout(guard));
  return { database, result };
}

async function withMutedErrors<T>(operation: () => Promise<T>): Promise<T> {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await operation();
  } finally {
    console.error = originalError;
  }
}

function assertRedactedTimeout(
  database: ReturnType<typeof recordingClient>,
  result: Awaited<ReturnType<WorkflowRunner['run']>>,
) {
  assert.equal(result.status, 'error');
  assert.equal(result.error_code, 'EXECUTION_TIMED_OUT');
  assert.ok(result.duration_ms < 200);

  const node = database.updates.find(({ table }) => table === 'flow_node_runs');
  const execution = database.updates.find(({ table }) => table === 'flow_executions');
  const failure = database.rpcs.find(({ name }) => name === 'record_tender_processing_failure');
  assert.equal(node?.value.safe_error_code, 'EXECUTION_TIMED_OUT');
  assert.equal(execution?.value.safe_error_code, 'EXECUTION_TIMED_OUT');
  assert.equal(failure?.parameters.p_processing_error_code, 'FLOW_STAGE_TIMEOUT');
  assert.equal(database.rpcs.some(({ name }) => name === 'release_pipeline_admission'), true);
}

test('actual runner bounds a never-settling code node at the workflow deadline', async () => {
  const { database, result } = await withMutedErrors(() => runWithDeadline('code', {
    code: 'return await new Promise(() => {});',
  }));

  assertRedactedTimeout(database, result);
});

test('runner consumes a code node rejection that arrives after its deadline', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { database, result } = await withMutedErrors(() => runWithDeadline('code', {
      code: "return await new Promise((_resolve, reject) => setTimeout(() => reject(new Error('private late failure')), 75));",
    }));
    assertRedactedTimeout(database, result);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, []);
    assert.equal(JSON.stringify(database).includes('private late failure'), false);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('actual runner aborts a wait timer and performs no late persistence', async () => {
  const { database, result } = await withMutedErrors(() => runWithDeadline('wait', {
    seconds: 60,
  }));

  assertRedactedTimeout(database, result);
  const updateCount = database.updates.length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(database.updates.length, updateCount);
});

test('actual runner aborts a stalled Supabase query at the workflow deadline', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let calls = 0;
  let aborts = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://deadline-test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'deadline-test-service-key';
  globalThis.fetch = (_input, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborts += 1;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
  };

  try {
    const { database, result } = await withMutedErrors(() => runWithDeadline('supabase.query', {
      table: 'tenders',
      filters: [{ column: 'id', value: tenderId }],
    }, 50));
    assertRedactedTimeout(database, result);
    assert.equal(calls, 1);
    assert.equal(aborts, 1);
    const updateCount = database.updates.length;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(database.updates.length, updateCount);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});
