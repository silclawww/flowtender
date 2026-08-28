import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeExecutor } from '../lib/nodes/code.ts';
import type { ExecutionContext } from '../types/execution.ts';

type WorkflowNode = { id: string; config: { code?: string; select?: string; body?: string } };
type Workflow = { nodes: WorkflowNode[]; edges: Array<{ from: string; to: string }> };

const workflow = JSON.parse(readFileSync(
  new URL('../workflows/tender-stage3-evaluation.json', import.meta.url), 'utf8',
)) as Workflow;
const node = (id: string) => {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  assert.ok(found, `missing workflow node ${id}`);
  return found;
};
async function run(id: string, input: Record<string, unknown>, context: ExecutionContext) {
  const code = node(id).config.code;
  assert.ok(code, `${id} must be a code node`);
  const result = await codeExecutor.execute({ code }, [{ json: input }], context);
  return result[0][0].json;
}

const common = {
  category: 'Register',
  note: null,
  cert_reference: null,
  cert_expiry: null,
};
const sourceRequirements = [
  { id: 'REQ-001', title: 'Aktueller Auszug aus dem Handelsregister', description: '', category: 'Register', is_critical: true },
  { id: 'REQ-002', title: 'Berufshaftpflicht', description: '', category: 'Versicherung', is_critical: false },
];

async function attach(
  company_requirement_evidence: Array<Record<string, unknown>>,
  tender_requirement_evidence: Array<Record<string, unknown>>,
) {
  return run('attach-requirement-evidence', { requirements: sourceRequirements }, new Map([
    ['trigger', [{ json: { company_requirement_evidence, tender_requirement_evidence } }]],
  ]));
}

test('Stage 3 carries reusable and exact evidence into initial and repair sources with one cutoff', async () => {
  assert.match(node('load-requirements').config.select ?? '', /eligibility_requirements/);
  const company = [{
    ...common, evidence_id: 'company-register', title: 'Handelsregistereintrag',
    status: 'verified', updated_at: '2026-08-05T20:00:00.000Z', legacy_identity: true,
  }];
  const exact = [{
    ...common, evidence_id: 'exact-req-002', title: 'Versicherungsnachweis',
    requirement_id: 'REQ-002', status: 'in_progress',
    updated_at: '2026-08-05T20:01:00.000Z',
  }];
  const prepared = await attach(company, exact);
  const promptData = JSON.parse(String(prepared.requirements_json));
  assert.deepEqual(promptData.reusable_company_evidence, company);
  assert.deepEqual(promptData.source_requirements[1].tender_requirement_evidence, exact[0]);
  assert.equal(prepared.evidence_cutoff_at, '2026-08-05T20:01:00.000Z');
  assert.match(node('evaluate-llm').config.body ?? '', /legacy_identity=true/);
  assert.match(node('reconcile-evaluation-llm').config.body ?? '', /WIEDERVERWENDBARE ANFORDERUNGSBELEGE/);

  const context: ExecutionContext = new Map([
    ['attach-requirement-evidence', [{ json: prepared }]],
  ]);
  const repair = await run('attach-evidence-to-repair', {
    reconciliation_source_requirements: sourceRequirements,
  }, context);
  assert.deepEqual(repair.reusable_company_evidence, company);
  assert.deepEqual(
    (repair.reconciliation_source_requirements as Array<Record<string, unknown>>)[1]
      .tender_requirement_evidence,
    exact[0],
  );
});

test('semantic company evidence survives wording variation while unrelated evidence is ignored', async () => {
  const prepared = await attach([
    { ...common, evidence_id: 'company-register', title: 'Handelsregistereintrag', status: 'verified', updated_at: '2026-08-05T20:00:00.000Z', legacy_identity: true },
    { ...common, evidence_id: 'unrelated', title: 'ISO Umweltmanagement', status: 'not_met', updated_at: '2026-08-05T20:00:01.000Z', legacy_identity: true },
  ], []);
  const context: ExecutionContext = new Map([
    ['attach-requirement-evidence', [{ json: prepared }]],
    ['load-requirements', [{ json: { requirements: sourceRequirements, eligibility_requirements: [] } }]],
  ]);
  const result = await run('apply-requirement-evidence-policy', {
    strategic_fit_score: 70,
    eligibility_requirements: sourceRequirements.map((source) => ({
      id: source.id, status: 'needs_review', is_blocking: false,
      profile_evidence: [], assessment_reason: 'Offen',
    })),
  }, context);
  const [register, insurance] = result.eligibility_requirements as Array<Record<string, unknown>>;
  assert.equal(register.status, 'compliant');
  assert.deepEqual(register.requirement_evidence, ['company-register']);
  assert.equal(insurance.status, 'needs_review');
  assert.equal('requirement_evidence' in insurance, false);
});

test('exact evidence overrides reusable evidence and confirmed failure blocks a critical requirement', async () => {
  const prepared = await attach([
    { ...common, evidence_id: 'company-register', title: 'Handelsregistereintrag', status: 'verified', updated_at: '2026-08-05T20:00:00.000Z', legacy_identity: true },
  ], [{
    ...common, evidence_id: 'exact-register', title: 'Registerprüfung', requirement_id: 'REQ-001',
    status: 'not_met', note: 'Auszug ist abgelaufen', updated_at: '2026-08-05T20:02:00.000Z',
  }]);
  const context: ExecutionContext = new Map([
    ['attach-requirement-evidence', [{ json: prepared }]],
    ['load-requirements', [{ json: { requirements: sourceRequirements, eligibility_requirements: [] } }]],
  ]);
  const result = await run('apply-requirement-evidence-policy', {
    strategic_fit_score: 80,
    eligibility_requirements: [{ id: 'REQ-001', status: 'compliant', is_blocking: false }],
  }, context);
  assert.deepEqual((result.eligibility_requirements as Array<Record<string, unknown>>)[0].requirement_evidence, ['exact-register']);
  assert.equal((result.eligibility_requirements as Array<Record<string, unknown>>)[0].status, 'not_met');
  assert.equal((result.eligibility_requirements as Array<Record<string, unknown>>)[0].is_blocking, true);
  assert.equal(result.bid_recommendation, 'recommend_no_bid');
  assert.equal((result.eligibility_summary as Record<string, unknown>).blocking_issues, 1);
});

test('not-applicable cannot clear a previous blocker and pending evidence withdraws prior positive proof', async () => {
  const prepared = await attach([], [
    { ...common, evidence_id: 'exact-register', title: 'Registerprüfung', requirement_id: 'REQ-001', status: 'not_applicable', note: 'Nach Prüfung nicht anwendbar', updated_at: '2026-08-05T20:02:00.000Z' },
    { ...common, evidence_id: 'exact-insurance', title: 'Versicherung', requirement_id: 'REQ-002', status: 'pending', updated_at: '2026-08-05T20:03:00.000Z' },
  ]);
  const context: ExecutionContext = new Map([
    ['attach-requirement-evidence', [{ json: prepared }]],
    ['load-requirements', [{ json: {
      requirements: sourceRequirements,
      eligibility_requirements: [
        { id: 'REQ-001', status: 'not_met', is_blocking: true },
        { id: 'REQ-002', status: 'compliant', is_blocking: false },
      ],
    } }]],
  ]);
  const result = await run('apply-requirement-evidence-policy', {
    eligibility_requirements: [
      { id: 'REQ-001', status: 'compliant', is_blocking: false },
      { id: 'REQ-002', status: 'compliant', is_blocking: false },
    ],
  }, context);
  const [register, insurance] = result.eligibility_requirements as Array<Record<string, unknown>>;
  assert.equal(register.status, 'not_met');
  assert.equal(register.is_blocking, true);
  assert.equal(insurance.status, 'needs_review');
  assert.equal(insurance.is_blocking, false);
});

test('the final saved summary identifies evaluation time and the maximum evidence snapshot', async () => {
  const context: ExecutionContext = new Map([
    ['attach-requirement-evidence', [{ json: { evidence_cutoff_at: '2026-08-05T20:03:00.000Z' } }]],
  ]);
  const result = await run('attach-evaluation-metadata', {
    eligibility_summary: { compliant_count: 1, partial_count: 0, not_met_count: 0, blocking_issues: 0 },
  }, context);
  const summary = result.eligibility_summary as Record<string, unknown>;
  assert.equal(summary.evidence_cutoff_at, '2026-08-05T20:03:00.000Z');
  assert.equal(Number.isNaN(Date.parse(String(summary.evaluated_at))), false);
  assert.ok(workflow.edges.some((edge) => edge.from === 'attach-evaluation-metadata' && edge.to === 'save-evaluation'));
});
