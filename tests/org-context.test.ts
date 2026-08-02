import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeExecutor } from '../lib/nodes/code.ts';
import type { ExecutionItem } from '../types/execution.ts';
import type { WorkflowDefinition, WorkflowNode } from '../types/workflow.ts';

const tenderId = '0b2f6f51-b91a-47db-b652-6a680a978efe';
const orgId = '3edb0931-87a3-45a6-a8f1-c1e87d539596';
const actorId = 'fca2e00f-80ad-4c6c-afbb-392cf49eb7b6';
const admissionId = 'c2b37af4-c299-4db7-859f-8423c3230d70';

function loadWorkflow(file: string): WorkflowDefinition {
  return JSON.parse(
    readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8'),
  ) as WorkflowDefinition;
}

function node(workflow: WorkflowDefinition, id: string): WorkflowNode {
  const result = workflow.nodes.find((candidate) => candidate.id === id);
  assert.ok(result, `missing node ${id}`);
  return result;
}

async function runTrigger(workflow: WorkflowDefinition, json: Record<string, unknown>) {
  return codeExecutor.execute(
    node(workflow, 'trigger').config,
    [{ json }] as ExecutionItem[],
    new Map(),
  );
}

for (const file of [
  'tender-stage2-requirements.json',
  'tender-stage3-evaluation.json',
]) {
  test(`${file} accepts only a complete UUID tenant context`, async () => {
    const workflow = loadWorkflow(file);
    const output = await runTrigger(workflow, {
      body: { tender_id: tenderId, org_id: orgId, user_id: actorId, admission_id: admissionId },
    });

    assert.deepEqual(output, [[{ json: { tender_id: tenderId, org_id: orgId, user_id: actorId } }]]);

    for (const invalid of [
      {},
      { tender_id: tenderId },
      { org_id: orgId },
      { tender_id: tenderId, org_id: orgId, user_id: actorId },
      { tender_id: 'customer-content-not-a-uuid', org_id: orgId },
      { tender_id: tenderId, org_id: 'customer-content-not-a-uuid' },
      { tender_id: tenderId, org_id: orgId, user_id: 'customer-content-not-a-uuid', admission_id: admissionId },
    ]) {
      await assert.rejects(
        () => runTrigger(workflow, invalid),
        (error: unknown) => {
          assert.equal(error instanceof Error, true);
          assert.match(String(error), /INVALID_TENANT_CONTEXT/);
          assert.doesNotMatch(String(error), /customer-content/);
          return true;
        },
      );
    }
  });

  test(`${file} validates context before any database or LLM node`, () => {
    const workflow = loadWorkflow(file);
    const nodesWithIncomingEdges = new Set(workflow.edges.map((edge) => edge.to));
    const startNodes = workflow.nodes
      .filter((candidate) => !nodesWithIncomingEdges.has(candidate.id))
      .map((candidate) => candidate.id);

    assert.deepEqual(startNodes, ['trigger']);
  });
}

test('stage 2 scopes every privileged tender read and update to both IDs', () => {
  const workflow = loadWorkflow('tender-stage2-requirements.json');
  const tenderOperations = workflow.nodes.filter((candidate) =>
    ['supabase.query', 'supabase.update'].includes(candidate.type)
      && candidate.config.table === 'tenders');

  assert.deepEqual(tenderOperations.map((candidate) => candidate.id), [
    'load-tender',
    'set-status',
    'save-requirements',
  ]);

  for (const operation of tenderOperations) {
    const filters = operation.config.filters as Array<{ column: string; value: string }>;
    assert.deepEqual(filters.map((filter) => filter.column).sort(), ['id', 'org_id']);
    assert.equal(
      filters.find((filter) => filter.column === 'org_id')?.value,
      "{{ $('trigger').first().json.org_id }}",
    );
  }
});

test('stage 3 scopes tender access to both IDs and loads the verified org profile', () => {
  const workflow = loadWorkflow('tender-stage3-evaluation.json');
  const tenderOperations = workflow.nodes.filter((candidate) =>
    ['supabase.query', 'supabase.update'].includes(candidate.type)
      && candidate.config.table === 'tenders');

  assert.deepEqual(tenderOperations.map((candidate) => candidate.id), [
    'load-requirements',
    'save-evaluation',
  ]);

  for (const operation of tenderOperations) {
    const filters = operation.config.filters as Array<{ column: string; value: string }>;
    assert.deepEqual(filters.map((filter) => filter.column).sort(), ['id', 'org_id']);
    assert.equal(
      filters.find((filter) => filter.column === 'org_id')?.value,
      "{{ $('trigger').first().json.org_id }}",
    );
  }

  assert.deepEqual(node(workflow, 'load-company-profile').config.filters, [{
    column: 'org_id',
    operator: 'eq',
    value: "{{ $('trigger').first().json.org_id }}",
  }]);
});
