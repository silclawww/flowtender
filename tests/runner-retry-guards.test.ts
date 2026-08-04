import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkflowRunner } from '../lib/runner/runner.ts';
import type { NodeRetryConfig, WorkflowDefinition } from '../types/workflow.ts';

const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';
const orgId = '3edb0931-87a3-45a6-a8f1-c1e87d539596';
const actorId = 'fca2e00f-80ad-4c6c-afbb-392cf49eb7b6';
const admissionId = 'c2b37af4-c299-4db7-859f-8423c3230d70';

interface CapturedMutation {
  table: string;
  value: Record<string, unknown>;
}

interface CapturedRpc {
  name: string;
  parameters: Record<string, unknown>;
}

function recordingClient() {
  const inserts: CapturedMutation[] = [];
  const updates: CapturedMutation[] = [];
  const rpcs: CapturedRpc[] = [];
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
          return {
            data: [{ claimed: true, reason: null, processing_status: 'evaluating' }],
            error: null,
          };
        }
        if (name === 'record_tender_processing_failure') {
          return {
            data: [{
              tender_id: tenderId,
              org_id: orgId,
              affected_count: 1,
              processing_attempt_count: 1,
            }],
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

function httpWorkflow(
  config: Record<string, unknown>,
  retry: NodeRetryConfig = { max_attempts: 3, delay_ms: 0 },
): WorkflowDefinition {
  return {
    id: 'tender-stage3-evaluation',
    name: 'Runner retry guard',
    nodes: [{
      id: 'provider-call',
      name: 'Provider call',
      type: 'http_request',
      config,
      retry,
    }],
    edges: [],
  };
}

function runStage3(
  runner: WorkflowRunner,
  timeoutMs: number,
) {
  return runner.run('tender-stage3-evaluation', {
    tender_id: tenderId,
    org_id: orgId,
    user_id: actorId,
    admission_id: admissionId,
  }, { timeoutMs });
}

async function withFetch(replacement: typeof fetch, operation: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    await operation();
  } finally {
    globalThis.fetch = original;
  }
}

test('runner does not multiply the HTTP executor persistent-429 retry budget', async () => {
  let calls = 0;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await withFetch(async () => {
      calls += 1;
      return new Response('', { status: 429, headers: { 'retry-after': '0' } });
    }, async () => {
      const database = recordingClient();
      const runner = new WorkflowRunner(database.client as never, () => httpWorkflow({
        method: 'POST',
        url: 'https://provider.invalid/v1/chat',
        timeout_ms: 1_000,
      }));
      const result = await runStage3(runner, 1_000);
      assert.equal(result.status, 'error');
      assert.equal(result.error_code, 'NODE_EXECUTION_FAILED');
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(calls, 4);
});

test('runner does not retry a bounded HTTP timeout', async () => {
  let calls = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    await withFetch((_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    }, async () => {
      const database = recordingClient();
      const runner = new WorkflowRunner(database.client as never, () => httpWorkflow({
        method: 'POST',
        url: 'https://provider.invalid/v1/chat',
        timeout_ms: 1,
      }));
      const result = await runStage3(runner, 1_000);
      assert.equal(result.status, 'error');
      assert.equal(result.error_code, 'NODE_EXECUTION_FAILED');
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(calls, 1);
});

test('runner deadline caps a longer HTTP attempt timeout', async () => {
  let calls = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    await withFetch((_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    }, async () => {
      const database = recordingClient();
      const runner = new WorkflowRunner(database.client as never, () => httpWorkflow({
        method: 'POST',
        url: 'https://provider.invalid/v1/chat',
        timeout_ms: 120_000,
      }));
      const result = await runStage3(runner, 10);
      assert.equal(result.status, 'error');
      assert.equal(result.error_code, 'EXECUTION_TIMED_OUT');
      assert.ok(result.duration_ms < 100);
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(calls, 1);
});

test('actual runner caps a retry delay at its deadline and persists only redacted timeout state', async () => {
  let calls = 0;
  const warnings: string[] = [];
  const errors: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (message?: unknown) => warnings.push(String(message));
  console.error = (message?: unknown) => errors.push(String(message));
  const database = recordingClient();
  const providerUrl = 'https://provider.invalid/private';
  const customerPrompt = 'customer prompt payload';
  const providerBody = 'provider secret response';

  try {
    await withFetch(async () => {
      calls += 1;
      return new Response(providerBody, { status: 503 });
    }, async () => {
      const runner = new WorkflowRunner(database.client as never, () => httpWorkflow({
        method: 'POST',
        url: providerUrl,
        body: customerPrompt,
        timeout_ms: 120_000,
      }, { max_attempts: 3, delay_ms: 1_000 }));
      const result = await runStage3(runner, 50);
      assert.equal(result.status, 'error');
      assert.equal(result.error_code, 'EXECUTION_TIMED_OUT');
      assert.ok(result.duration_ms < 250);
    });
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  const waitMs = Number(/waiting (\d+)ms/.exec(warnings[0])?.[1]);
  assert.ok(waitMs > 0 && waitMs <= 50);
  assert.deepEqual(errors, ['[flowtender] stage provider-call failed with EXECUTION_TIMED_OUT']);

  const nodeCompletion = database.updates.find(({ table }) => table === 'flow_node_runs');
  const executionCompletion = database.updates.find(({ table }) => table === 'flow_executions');
  assert.equal(nodeCompletion?.value.safe_error_code, 'EXECUTION_TIMED_OUT');
  assert.equal(executionCompletion?.value.safe_error_code, 'EXECUTION_TIMED_OUT');
  const failure = database.rpcs.find(({ name }) => name === 'record_tender_processing_failure');
  assert.equal(failure?.parameters.p_processing_error_code, 'FLOW_STAGE_TIMEOUT');

  const persisted = JSON.stringify({
    inserts: database.inserts,
    updates: database.updates,
    rpcs: database.rpcs,
  });
  for (const privateValue of [providerUrl, customerPrompt, providerBody]) {
    assert.equal(persisted.includes(privateValue), false);
  }
});

test('an already-expired actual workflow starts zero provider calls and persists timeout', async () => {
  let calls = 0;
  const originalError = console.error;
  console.error = () => {};
  const database = recordingClient();
  try {
    await withFetch(async () => {
      calls += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }, async () => {
      const runner = new WorkflowRunner(database.client as never, () => httpWorkflow({
        method: 'POST',
        url: 'https://provider.invalid/v1/chat',
      }));
      const result = await runStage3(runner, 0);
      assert.equal(result.status, 'error');
      assert.equal(result.error_code, 'EXECUTION_TIMED_OUT');
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(calls, 0);
  assert.equal(database.inserts.some(({ table }) => table === 'flow_node_runs'), false);
  const executionCompletion = database.updates.find(({ table }) => table === 'flow_executions');
  assert.equal(executionCompletion?.value.safe_error_code, 'EXECUTION_TIMED_OUT');
  const failure = database.rpcs.find(({ name }) => name === 'record_tender_processing_failure');
  assert.equal(failure?.parameters.p_processing_error_code, 'FLOW_STAGE_TIMEOUT');
});
