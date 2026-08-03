import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSupabaseQueryExecutor,
  createSupabaseUpsertExecutor,
} from '../lib/nodes/supabase.ts';

interface ProviderResult {
  data: unknown;
  error: unknown | null;
}

const input = [{ json: {
  id: '0b2f6f51-b91a-47db-b652-6a680a978efe',
  org_id: '3edb0931-87a3-45a6-a8f1-c1e87d539596',
} }];

function fakeQueryClient(result: ProviderResult | Error) {
  const query = {
    eq() { return query; },
    single() {
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    then<TResult1 = ProviderResult, TResult2 = never>(
      onfulfilled?: ((value: ProviderResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      const promise = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      return promise.then(onfulfilled, onrejected);
    },
  };

  return {
    from(table: string) {
      assert.equal(table, 'tenders');
      return { select: () => query };
    },
  };
}

function fakeUpsertClient(result: ProviderResult | Error) {
  return {
    from(table: string) {
      assert.equal(table, 'tenders');
      return {
        upsert(data: Record<string, unknown>, options: { onConflict: string }) {
          assert.deepEqual(data, input[0].json);
          assert.deepEqual(options, { onConflict: 'id' });
          return {
            select() {
              return {
                single() {
                  return result instanceof Error
                    ? Promise.reject(result)
                    : Promise.resolve(result);
                },
              };
            },
          };
        },
      };
    },
  };
}

test('single query returns exactly one persisted object', async () => {
  const row = { ...input[0].json, title: 'Persisted title' };
  const executor = createSupabaseQueryExecutor(
    () => fakeQueryClient({ data: row, error: null }) as never,
  );

  assert.deepEqual(
    await executor.execute({ table: 'tenders', single: true }, input, new Map()),
    [[{ json: row }]],
  );
});

test('single query fails closed for null, arrays, provider errors, and rejected operations', async () => {
  const rawDetail = 'secret tender text and database hostname';
  const fixtures: Array<ProviderResult | Error> = [
    { data: null, error: null },
    { data: [], error: null },
    { data: [{ id: 'one' }], error: null },
    { data: null, error: { message: rawDetail } },
    new Error(rawDetail),
  ];

  for (const fixture of fixtures) {
    const executor = createSupabaseQueryExecutor(() => fakeQueryClient(fixture) as never);
    await assert.rejects(
      () => executor.execute({ table: 'tenders', single: true }, input, new Map()),
      (error: unknown) => {
        assert.equal(String(error), 'Error: SUPABASE_QUERY_FAILED');
        assert.doesNotMatch(String(error), /secret tender text|database hostname/);
        return true;
      },
    );
  }
});

test('list query preserves a legitimate empty result', async () => {
  const executor = createSupabaseQueryExecutor(
    () => fakeQueryClient({ data: [], error: null }) as never,
  );

  assert.deepEqual(
    await executor.execute({ table: 'tenders' }, input, new Map()),
    [[]],
  );
});

test('upsert returns the one persisted object', async () => {
  const persisted = { ...input[0].json, server_default: true };
  const executor = createSupabaseUpsertExecutor(
    () => fakeUpsertClient({ data: persisted, error: null }) as never,
  );

  assert.deepEqual(
    await executor.execute({ table: 'tenders', data: 'auto_map' }, input, new Map()),
    [[{ json: persisted }]],
  );
});

test('upsert never substitutes input for null or malformed returned data', async () => {
  for (const data of [null, [], [input[0].json]]) {
    const executor = createSupabaseUpsertExecutor(
      () => fakeUpsertClient({ data, error: null }) as never,
    );
    await assert.rejects(
      () => executor.execute({ table: 'tenders', data: 'auto_map' }, input, new Map()),
      (error: unknown) => String(error) === 'Error: SUPABASE_UPSERT_FAILED',
    );
  }
});

test('upsert redacts provider errors and rejected operations', async () => {
  const rawDetail = 'secret tender text and database hostname';
  const fixtures: Array<ProviderResult | Error> = [
    { data: null, error: { message: rawDetail } },
    new Error(rawDetail),
  ];

  for (const fixture of fixtures) {
    const executor = createSupabaseUpsertExecutor(() => fakeUpsertClient(fixture) as never);
    await assert.rejects(
      () => executor.execute({ table: 'tenders', data: 'auto_map' }, input, new Map()),
      (error: unknown) => {
        assert.equal(String(error), 'Error: SUPABASE_UPSERT_FAILED');
        assert.doesNotMatch(String(error), /secret tender text|database hostname/);
        return true;
      },
    );
  }
});
