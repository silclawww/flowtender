import assert from 'node:assert/strict';
import test from 'node:test';

import { createSupabaseUpdateExecutor } from '../lib/nodes/supabase.ts';

interface MutationResult {
  data: Array<Record<string, unknown>> | null;
  error: unknown | null;
}

function fakeUpdateClient(result: MutationResult) {
  const filters: Array<[string, unknown]> = [];
  const query = {
    select() {
      return query;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return query;
    },
    then<TResult1 = MutationResult, TResult2 = never>(
      onfulfilled?: ((value: MutationResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };

  return {
    filters,
    client: {
      from(table: string) {
        assert.equal(table, 'tenders');
        return {
          update(_data: Record<string, unknown>) {
            return query;
          },
        };
      },
    },
  };
}

const config = {
  table: 'tenders',
  filters: [
    { column: 'id', value: '{{ $json.id }}' },
    { column: 'org_id', value: '{{ $json.org_id }}' },
  ],
  data: { processing_status: 'complete' },
};

const input = [{ json: {
  id: '0b2f6f51-b91a-47db-b652-6a680a978efe',
  org_id: '3edb0931-87a3-45a6-a8f1-c1e87d539596',
} }];

test('the real update adapter applies both filters and returns persisted rows', async () => {
  const persisted = { ...input[0].json, processing_status: 'complete' };
  const fake = fakeUpdateClient({ data: [persisted], error: null });
  const executor = createSupabaseUpdateExecutor(() => fake.client as never);

  const result = await executor.execute(config, input, new Map());

  assert.deepEqual(fake.filters, [
    ['id', input[0].json.id],
    ['org_id', input[0].json.org_id],
  ]);
  assert.deepEqual(result, [[{ json: persisted }]]);
});

test('the update adapter fails closed when tenant filters affect zero rows', async () => {
  const fake = fakeUpdateClient({ data: [], error: null });
  const executor = createSupabaseUpdateExecutor(() => fake.client as never);

  await assert.rejects(
    () => executor.execute(config, input, new Map()),
    (error: unknown) => {
      assert.equal(String(error), 'Error: SUPABASE_UPDATE_FAILED');
      assert.doesNotMatch(String(error), new RegExp(String(input[0].json.id)));
      return true;
    },
  );
});

test('the update adapter redacts provider error details', async () => {
  const fake = fakeUpdateClient({
    data: null,
    error: { message: 'customer row contained secret tender text' },
  });
  const executor = createSupabaseUpdateExecutor(() => fake.client as never);

  await assert.rejects(
    () => executor.execute(config, input, new Map()),
    (error: unknown) => {
      assert.equal(String(error), 'Error: SUPABASE_UPDATE_FAILED');
      assert.doesNotMatch(String(error), /secret tender text/);
      return true;
    },
  );
});

test('the update adapter also redacts rejected client operations', async () => {
  const executor = createSupabaseUpdateExecutor(() => {
    throw new Error('customer row and database hostname');
  });

  await assert.rejects(
    () => executor.execute(config, input, new Map()),
    (error: unknown) => {
      assert.equal(String(error), 'Error: SUPABASE_UPDATE_FAILED');
      assert.doesNotMatch(String(error), /customer row|database hostname/);
      return true;
    },
  );
});
