import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeExecutor } from '../lib/nodes/code.ts';
import type { ExecutionContext, ExecutionItem } from '../types/execution.ts';

type JsonObject = Record<string, unknown>;
type Workflow = { nodes: Array<{ id: string; config: { code?: string } }> };
type GoldenCase = {
  name: string;
  source_text: string;
  metadata_response: JsonObject;
  expected_critical_fields: JsonObject;
  requirements_response: JsonObject[];
  expected_critical_requirement_ids: string[];
};

const dataset = JSON.parse(
  readFileSync(new URL('./fixtures/pilot-golden.json', import.meta.url), 'utf8'),
) as GoldenCase[];

function workflowCode(file: string, nodeId: string): string {
  const workflow = JSON.parse(
    readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8'),
  ) as Workflow;
  const code = workflow.nodes.find((node) => node.id === nodeId)?.config.code;
  assert.ok(code, `missing workflow node ${nodeId}`);
  return code;
}

function llmResponse(content: unknown): ExecutionItem[] {
  return [{ json: { choices: [{ message: { content: JSON.stringify(content) } }] } }];
}

for (const golden of dataset) {
  test(`golden: ${golden.name}`, async () => {
    const metadataContext: ExecutionContext = new Map([
      ['trigger', [{ json: { tender_id: golden.name, org_id: 'golden-org', file_name: 'golden.pdf' } }]],
      ['extract-text', [{ json: { pdf_text: golden.source_text, page_count: 1 } }]],
    ]);
    const metadataResult = await codeExecutor.execute(
      { code: workflowCode('tender-stage1-pdf.json', 'parse-metadata') },
      llmResponse(golden.metadata_response),
      metadataContext,
    );
    const metadata = metadataResult[0][0].json;
    for (const [field, expected] of Object.entries(golden.expected_critical_fields)) {
      assert.equal(metadata[field], expected, `${golden.name}: ${field}`);
      if (typeof expected === 'string' && field !== 'deadline') {
        assert.ok(golden.source_text.includes(expected), `${golden.name}: ${field} is not source-grounded`);
      }
    }
    const deadline = golden.expected_critical_fields.deadline;
    if (typeof deadline === 'string') {
      const [year, month, day] = deadline.split('-');
      assert.ok(golden.source_text.includes(`${day}.${month}.${year}`), `${golden.name}: deadline is not source-grounded`);
    } else {
      assert.match(golden.source_text, /Abgabefrist.*später/i, `${golden.name}: missing deadline is not explicit`);
    }

    const requirementsResult = await codeExecutor.execute(
      { code: workflowCode('tender-stage2-requirements.json', 'parse-requirements') },
      llmResponse(golden.requirements_response),
      new Map(),
    );
    const requirements = requirementsResult[0][0].json.requirements as JsonObject[];
    const criticalIds = requirements
      .filter((requirement) => requirement.is_critical === true)
      .map((requirement) => requirement.id);
    assert.deepEqual(criticalIds, golden.expected_critical_requirement_ids);
    for (const requirement of requirements) {
      for (const fragment of requirement.source_fragments as string[]) {
        assert.ok(golden.source_text.includes(fragment), `${golden.name}: source fragment is not grounded`);
      }
    }
  });
}
