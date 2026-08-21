import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeExecutor } from '../lib/nodes/code.ts';
import type { ExecutionContext } from '../types/execution.ts';

type WorkflowNode = { id: string; config: { code?: string; select?: string } };
type Workflow = {
  nodes: WorkflowNode[];
  edges: Array<{ from: string; to: string }>;
};

const workflow = JSON.parse(readFileSync(
  new URL('../workflows/tender-stage3-evaluation.json', import.meta.url),
  'utf8',
)) as Workflow;

function node(id: string): WorkflowNode {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  assert.ok(found, `missing workflow node ${id}`);
  return found;
}

async function run(id: string, input: Record<string, unknown>, context: ExecutionContext) {
  const code = node(id).config.code;
  assert.ok(code, `${id} must be a code node`);
  const result = await codeExecutor.execute({ code }, [{ json: input }], context);
  return result[0][0].json;
}

test('Stage 3 applies only exact-ID verified evidence and records the snapshot cutoff', async () => {
  assert.match(node('load-requirements').config.select ?? '', /eligibility_requirements/);
  const context: ExecutionContext = new Map([
    ['trigger', [{ json: {
      requirement_evidence: [
        {
          requirement_id: 'REQ-001',
          status: 'verified',
          note: 'Nachweis liegt vor',
          cert_reference: 'ZERT-1',
          cert_expiry: null,
          updated_at: '2026-08-05T20:00:00.000Z',
        },
        {
          requirement_id: 'REQ-002',
          status: 'not_applicable',
          note: null,
          cert_reference: null,
          cert_expiry: null,
          updated_at: '2026-08-05T20:01:00.000Z',
        },
      ],
    } }]],
  ]);
  const prepared = await run('attach-requirement-evidence', {
    requirements: [
      { id: 'REQ-001', title: 'Freigabe', is_critical: false },
      { id: 'REQ-002', title: 'Zulassung', is_critical: true },
    ],
  }, context);
  const requirements = JSON.parse(String(prepared.requirements_json));

  assert.deepEqual(requirements[0].customer_evidence, {
    status: 'verified',
    note: 'Nachweis liegt vor',
    cert_reference: 'ZERT-1',
    cert_expiry: null,
  });
  assert.equal('customer_evidence' in requirements[1], false);
  assert.deepEqual(prepared.not_applicable_evidence_ids, ['REQ-002']);
  assert.equal(prepared.evidence_cutoff_at, '2026-08-05T20:01:00.000Z');

  context.set('attach-requirement-evidence', [{ json: prepared }]);
  const repair = await run('attach-evidence-to-repair', {
    reconciliation_source_requirements: [
      { id: 'REQ-001', title: 'Freigabe' },
      { id: 'REQ-002', title: 'Zulassung' },
    ],
  }, context);
  assert.deepEqual(
    (repair.reconciliation_source_requirements as Array<Record<string, unknown>>)[0].customer_evidence,
    requirements[0].customer_evidence,
  );
});

test('not-applicable evidence cannot replace a prior blocker or invent compliance', async () => {
  const context: ExecutionContext = new Map([
    ['load-requirements', [{ json: {
      eligibility_requirements: [{ id: 'REQ-002', status: 'not_met', is_blocking: true }],
    } }]],
    ['attach-requirement-evidence', [{ json: {
      not_applicable_evidence_ids: ['REQ-002'],
    } }]],
  ]);
  const result = await run('apply-requirement-evidence-policy', {
    eligibility_requirements: [{ id: 'REQ-002', status: 'compliant', is_blocking: false }],
  }, context);

  assert.deepEqual(result.eligibility_requirements, [
    { id: 'REQ-002', status: 'not_met', is_blocking: true },
  ]);
});

test('withdrawn evidence is not proof and does not preserve a prior positive judgment', async () => {
  const context: ExecutionContext = new Map([
    ['trigger', [{ json: {
      requirement_evidence: [{
        requirement_id: 'REQ-001',
        status: 'pending',
        note: null,
        cert_reference: null,
        cert_expiry: null,
        updated_at: '2026-08-06T01:00:00.000Z',
      }],
    } }]],
    ['load-requirements', [{ json: {
      eligibility_requirements: [{ id: 'REQ-001', status: 'compliant', is_blocking: false }],
    } }]],
  ]);
  const prepared = await run('attach-requirement-evidence', {
    requirements: [{ id: 'REQ-001', title: 'Freigabe', is_critical: false }],
  }, context);
  const requirements = JSON.parse(String(prepared.requirements_json));

  assert.equal('customer_evidence' in requirements[0], false);
  assert.equal(prepared.evidence_cutoff_at, '2026-08-06T01:00:00.000Z');
  context.set('attach-requirement-evidence', [{ json: prepared }]);
  const result = await run('apply-requirement-evidence-policy', {
    eligibility_requirements: [{
      id: 'REQ-001',
      status: 'needs_review',
      is_blocking: false,
      review_reason: 'Nachweis wurde zurückgezogen.',
    }],
  }, context);

  assert.deepEqual(result.eligibility_requirements, [{
    id: 'REQ-001',
    status: 'needs_review',
    is_blocking: false,
    review_reason: 'Nachweis wurde zurückgezogen.',
  }]);
});

test('the final saved summary identifies evaluation time and exact evidence snapshot', async () => {
  const context: ExecutionContext = new Map([
    ['attach-requirement-evidence', [{ json: {
      evidence_cutoff_at: '2026-08-05T20:01:00.000Z',
    } }]],
  ]);
  const result = await run('attach-evaluation-metadata', {
    eligibility_summary: { compliant_count: 1, partial_count: 0, not_met_count: 0, blocking_issues: 0 },
  }, context);
  const summary = result.eligibility_summary as Record<string, unknown>;

  assert.equal(summary.evidence_cutoff_at, '2026-08-05T20:01:00.000Z');
  assert.equal(Number.isNaN(Date.parse(String(summary.evaluated_at))), false);
  assert.ok(workflow.edges.some((edge) => edge.from === 'attach-evaluation-metadata' && edge.to === 'save-evaluation'));
});
