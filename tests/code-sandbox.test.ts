import assert from 'node:assert/strict';
import test from 'node:test';

import { codeExecutor } from '../lib/nodes/code.ts';

test('code nodes cannot access process or unapproved modules', async () => {
  const result = await codeExecutor.execute(
    { code: "return [{ json: { process_type: typeof process } }];" },
    [{ json: {} }],
    new Map(),
  );
  assert.deepEqual(result, [[{ json: { process_type: 'undefined' } }]]);

  await assert.rejects(
    () => codeExecutor.execute(
      { code: "return require('fs');" },
      [{ json: {} }],
      new Map(),
    ),
    /require\('fs'\) not allowed in code nodes/,
  );
});
