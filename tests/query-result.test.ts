import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyListQuery,
  classifySingleQuery,
} from '../lib/query-result.ts';

test('single-row queries distinguish an actual missing row from operational errors', () => {
  assert.deepEqual(
    classifySingleQuery({
      data: null,
      error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
    }),
    { kind: 'not_found' },
  );

  assert.deepEqual(
    classifySingleQuery({
      data: null,
      error: { code: '42P01', message: 'relation does not exist' },
    }),
    { kind: 'operational_error' },
  );

  assert.deepEqual(
    classifySingleQuery({
      data: null,
      error: { code: '57P01', message: 'database is restarting' },
    }),
    { kind: 'operational_error' },
  );
});

test('single-row queries return data only when the client reports a row without error', () => {
  const row = { id: 'execution-id' };
  assert.deepEqual(classifySingleQuery({ data: row, error: null }), {
    kind: 'found',
    data: row,
  });
  assert.deepEqual(classifySingleQuery({ data: null, error: null }), {
    kind: 'operational_error',
  });
});

test('list queries surface node-run database errors instead of substituting an empty list', () => {
  assert.deepEqual(classifyListQuery({ data: [], error: null }), {
    kind: 'found',
    data: [],
  });
  assert.deepEqual(classifyListQuery({
    data: null,
    error: { code: '42703', message: 'column stage does not exist' },
  }), {
    kind: 'operational_error',
  });
});
