import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeExecutor } from '../lib/nodes/code.ts';
import type { ExecutionContext, ExecutionItem } from '../types/execution.ts';

interface WorkflowCodeNode {
  id: string;
  type: string;
  config: { code?: string };
}

function workflowCode(file: string, nodeId: string): string {
  const workflow = JSON.parse(readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8')) as {
    nodes: WorkflowCodeNode[];
  };
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  assert.ok(node?.config.code, `missing code node ${nodeId}`);
  return node.config.code;
}

async function assertInvalidJsonFailsSafely(
  file: string,
  nodeId: string,
  context: ExecutionContext = new Map(),
) {
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => logged.push(values);
  const input: ExecutionItem[] = [{
    json: { choices: [{ message: { content: '{invalid required json' } }] },
  }];

  try {
    await assert.rejects(
      () => codeExecutor.execute({ code: workflowCode(file, nodeId) }, input, context),
      /LLM_RESPONSE_INVALID_JSON/,
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(logged, [['LLM_RESPONSE_INVALID_JSON']]);
}

test('stage 2 fails closed when the requirements LLM returns invalid JSON', async () => {
  await assertInvalidJsonFailsSafely('tender-stage2-requirements.json', 'parse-requirements');
});

test('stage 2 fails closed when workload classification JSON is invalid', async () => {
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { gaeb_positions: [{ id: 'position-1' }] } }]],
  ]);
  await assertInvalidJsonFailsSafely('tender-stage2-requirements.json', 'parse-workload', context);
});

test('stage 3 fails closed when the evaluation LLM returns invalid JSON', async () => {
  const context: ExecutionContext = new Map([
    ['load-requirements', [{ json: { id: 'tender-id' } }]],
  ]);
  await assertInvalidJsonFailsSafely('tender-stage3-evaluation.json', 'parse-evaluation', context);
});
