import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TelemetryPersistenceError,
  persistExactlyOneTelemetryRow,
} from '../lib/telemetry-persistence.ts';

interface FakeMutationResult {
  data: unknown[] | null;
  error: unknown | null;
}

function fakeClient(result: FakeMutationResult) {
  const filteredMutation = {
    eq(_column: string, _value: unknown) {
      return filteredMutation;
    },
    async select(_columns: string) {
      return result;
    },
  };

  return {
    from(_table: string) {
      return {
        insert(_value: unknown) {
          return {
            async select(_columns: string) {
              return result;
            },
          };
        },
        update(_value: unknown) {
          return filteredMutation;
        },
      };
    },
  };
}

test('a resolved Supabase database error becomes a fixed safe persistence error', async () => {
  const rawDatabaseDetail = 'relation flow_executions contains secret schema detail';
  const client = fakeClient({
    data: null,
    error: { code: '42P01', message: rawDatabaseDetail },
  });

  await assert.rejects(
    () => persistExactlyOneTelemetryRow(
      () => client.from('flow_executions').insert({}).select('id'),
    ),
    (error: unknown) => {
      assert.ok(error instanceof TelemetryPersistenceError);
      assert.equal(error.code, 'TELEMETRY_PERSISTENCE_FAILED');
      assert.equal(error.message, 'Telemetry persistence failed');
      assert.equal(String(error).includes(rawDatabaseDetail), false);
      return true;
    },
  );
});

test('a successful mutation that affected zero rows fails closed', async () => {
  const client = fakeClient({ data: [], error: null });

  await assert.rejects(
    () => persistExactlyOneTelemetryRow(
      () => client.from('flow_executions').update({ status: 'done' }).eq('id', 'missing').select('id'),
    ),
    (error: unknown) => error instanceof TelemetryPersistenceError,
  );
});

test('failed initial persistence prevents subsequent paid workflow work', async () => {
  const client = fakeClient({
    data: null,
    error: { code: '503', message: 'database unavailable' },
  });
  let paidWorkflowCalls = 0;

  const startWorkflow = async () => {
    await persistExactlyOneTelemetryRow(
      () => client.from('flow_executions').insert({}).select('id'),
    );
    paidWorkflowCalls += 1;
  };

  await assert.rejects(startWorkflow, TelemetryPersistenceError);
  assert.equal(paidWorkflowCalls, 0);
});

test('a telemetry mutation must affect exactly one row', async () => {
  const oneRow = fakeClient({ data: [{ id: 'execution-id' }], error: null });
  const twoRows = fakeClient({ data: [{ id: 'one' }, { id: 'two' }], error: null });

  await persistExactlyOneTelemetryRow(
    () => oneRow.from('flow_executions').insert({}).select('id'),
  );
  await assert.rejects(
    () => persistExactlyOneTelemetryRow(
      () => twoRows.from('flow_executions').insert({}).select('id'),
    ),
    (error: unknown) => error instanceof TelemetryPersistenceError,
  );
});

test('a rejected client operation is also redacted', async () => {
  await assert.rejects(
    () => persistExactlyOneTelemetryRow(async () => {
      throw new Error('socket failed with raw database host');
    }),
    (error: unknown) => {
      assert.ok(error instanceof TelemetryPersistenceError);
      assert.equal(error.message, 'Telemetry persistence failed');
      assert.equal(String(error).includes('database host'), false);
      return true;
    },
  );
});
