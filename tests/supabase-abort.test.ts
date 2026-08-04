import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSupabaseQueryExecutor,
  createSupabaseUpdateExecutor,
  createSupabaseUpsertExecutor,
} from '../lib/nodes/supabase.ts';

const input = [{ json: {
  id: '0b2f6f51-b91a-47db-b652-6a680a978efe',
  org_id: '3edb0931-87a3-45a6-a8f1-c1e87d539596',
} }];

function stalledClient() {
  let receivedSignal: AbortSignal | undefined;
  let aborts = 0;
  const operation = {
    select() { return operation; },
    single() { return operation; },
    eq() { return operation; },
    upsert() { return operation; },
    update() { return operation; },
    abortSignal(signal: AbortSignal) {
      receivedSignal = signal;
      return operation;
    },
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      const promise = new Promise<never>((_resolve, reject) => {
        if (receivedSignal?.aborted) {
          aborts += 1;
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        receivedSignal?.addEventListener('abort', () => {
          aborts += 1;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
      return promise.then(onfulfilled, onrejected);
    },
  };
  return {
    client: { from: () => operation },
    get receivedSignal() { return receivedSignal; },
    get aborts() { return aborts; },
  };
}

for (const [name, createExecutor, config, expectedError] of [
  [
    'query',
    createSupabaseQueryExecutor,
    { table: 'tenders', filters: [{ column: 'id', value: input[0].json.id }] },
    'Error: SUPABASE_QUERY_FAILED',
  ],
  [
    'upsert',
    createSupabaseUpsertExecutor,
    { table: 'tenders', data: 'auto_map' },
    'Error: SUPABASE_UPSERT_FAILED',
  ],
  [
    'update',
    createSupabaseUpdateExecutor,
    {
      table: 'tenders',
      filters: [{ column: 'id', value: input[0].json.id }],
      data: { processing_status: 'complete' },
    },
    'Error: SUPABASE_UPDATE_FAILED',
  ],
] as const) {
  test(`Supabase ${name} forwards and honors the runner abort signal`, async () => {
    const stalled = stalledClient();
    const controller = new AbortController();
    const executor = createExecutor(() => stalled.client as never);
    const execution = executor.execute(config, input, new Map(), { signal: controller.signal });
    controller.abort();

    await assert.rejects(execution, error => String(error) === expectedError);
    assert.equal(stalled.receivedSignal, controller.signal);
    assert.equal(stalled.aborts, 1);
  });
}
