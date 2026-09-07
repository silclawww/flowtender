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
  return run('attach-requirement-evidence', {
    requirements: sourceRequirements,
    company_profile: {},
    profile_evidence_contract: { version: 1, available_fields: [] },
    requirement_evidence_fields: { 'REQ-001': [], 'REQ-002': [] },
    requirement_evidence_policy: {
      'REQ-001': { allowed_fields: [], allowed_statuses: ['needs_review'] },
      'REQ-002': { allowed_fields: [], allowed_statuses: ['needs_review'] },
    },
    score_methodology: {
      version: 1,
      component_maxima: {
        trade_scope_fit: 25,
        capacity_project_size_fit: 20,
        region_delivery_model_fit: 15,
        references_qualifications_fit: 25,
        execution_value_creation_fit: 15,
      },
    },
  }, new Map([
    ['trigger', [{ json: { company_requirement_evidence, tender_requirement_evidence } }]],
  ]));
}

test('Stage 3 ignores reusable slugs and carries exact N/A into initial and repair sources', async () => {
  assert.match(node('load-requirements').config.select ?? '', /eligibility_requirements/);
  const company = [{
    ...common, evidence_id: 'company-register', title: 'Handelsregistereintrag',
    status: 'verified', updated_at: '2026-08-05T20:00:00.000Z', legacy_identity: true,
  }];
  const exact = [{
    ...common, evidence_id: 'exact-req-002', title: 'Versicherungsnachweis',
    requirement_id: 'REQ-002', status: 'not_applicable', note: 'Nach Quellprüfung nicht anwendbar',
    updated_at: '2026-08-05T20:01:00.000Z',
  }];
  const prepared = await attach(company, exact);
  const promptData = JSON.parse(String(prepared.requirements_json));
  assert.equal(promptData.reusable_company_evidence, undefined);
  assert.deepEqual(promptData.source_requirements[1].tender_requirement_evidence, exact[0]);
  assert.equal(prepared.evidence_cutoff_at, '2026-08-05T20:01:00.000Z');
  assert.doesNotMatch(node('evaluate-llm').config.body ?? '', /legacy_identity=true/);
  assert.doesNotMatch(node('reconcile-evaluation-llm').config.body ?? '', /WIEDERVERWENDBARE ANFORDERUNGSBELEGE/);

  const context: ExecutionContext = new Map([
    ['attach-requirement-evidence', [{ json: prepared }]],
  ]);
  const repair = await run('attach-evidence-to-repair', {
    reconciliation_source_requirements: sourceRequirements,
  }, context);
  assert.equal(repair.reusable_company_evidence, undefined);
  assert.deepEqual(
    (repair.reconciliation_source_requirements as Array<Record<string, unknown>>)[1]
      .tender_requirement_evidence,
    exact[0],
  );
});

test('legacy company rows cannot be cited or broaden any requirement status', async () => {
  const prepared = await attach([
    { ...common, evidence_id: 'company-register', title: 'Handelsregistereintrag', status: 'verified', updated_at: '2026-08-05T20:00:00.000Z', legacy_identity: true },
    { ...common, evidence_id: 'unrelated', title: 'ISO Umweltmanagement', status: 'not_met', updated_at: '2026-08-05T20:00:01.000Z', legacy_identity: true },
  ], []);
  const context: ExecutionContext = new Map([
    ['attach-requirement-evidence', [{ json: prepared }]],
    ['prepare-context', [{ json: prepared }]],
    ['load-requirements', [{ json: { requirements: sourceRequirements, eligibility_requirements: [] } }]],
  ]);
  const candidate = {
    strategic_fit_score: 50,
    score_components: {
      trade_scope_fit: 13, capacity_project_size_fit: 10, region_delivery_model_fit: 8,
      references_qualifications_fit: 12, execution_value_creation_fit: 7,
    },
    rationale: 'Die Registeranforderung ist belegt; die Versicherung bleibt offen.',
    strengths: [],
    eligibility_requirements: [
      {
        id: 'REQ-001', status: 'compliant', is_blocking: false,
        profile_evidence: ['requirement_evidence'],
        assessment_reason: 'Semantisch passender Beleg evidence_id=company-register',
      },
      {
        id: 'REQ-002', status: 'needs_review', is_blocking: false,
        profile_evidence: [], assessment_reason: 'Kein sachlich passender Beleg.',
      },
    ],
    risks: [],
    clarifications: [],
  };
  const inspected = await run('inspect-evaluation', {
    choices: [{ message: { content: JSON.stringify(candidate) } }],
  }, context);
  assert.equal(inspected.reconciliation_required, true);

  const result = await run('apply-requirement-evidence-policy', {
    ...candidate,
    eligibility_requirements: (candidate.eligibility_requirements as Array<Record<string, unknown>>)
      .map(item => item.id === 'REQ-001'
        ? { ...item, status: 'needs_review', profile_evidence: [], assessment_reason: 'Kein Profilbeleg.' }
        : item),
  }, context);
  const [register, insurance] = result.eligibility_requirements as Array<Record<string, unknown>>;
  assert.equal(register.status, 'needs_review');
  assert.deepEqual(register.profile_evidence, []);
  assert.equal(insurance.status, 'needs_review');
  assert.equal('requirement_evidence' in insurance, false);
});

test('legacy company rows never automatically strengthen a model judgment', async () => {
  const prepared = await attach([
    { ...common, evidence_id: 'legacy-register', title: 'Handelsregistereintrag', status: 'verified', updated_at: '2026-08-05T20:00:00.000Z', legacy_identity: true },
  ], []);
  const context: ExecutionContext = new Map([
    ['attach-requirement-evidence', [{ json: prepared }]],
    ['load-requirements', [{ json: { requirements: sourceRequirements, eligibility_requirements: [] } }]],
  ]);
  const result = await run('apply-requirement-evidence-policy', {
    strategic_fit_score: 50,
    eligibility_requirements: [{ id: 'REQ-001', status: 'needs_review', is_blocking: false }],
  }, context);
  assert.equal((result.eligibility_requirements as Array<Record<string, unknown>>)[0].status, 'needs_review');
  assert.equal('requirement_evidence' in (result.eligibility_requirements as Array<Record<string, unknown>>)[0], false);
});

test('exact user not-met confirmation updates the requirement and blocker', async () => {
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
    eligibility_requirements: [{
      id: 'REQ-001', status: 'needs_review', is_blocking: false, profile_evidence: [],
    }],
  }, context);
  const requirement = (result.eligibility_requirements as Array<Record<string, unknown>>)[0];
  assert.deepEqual(requirement.requirement_evidence, ['exact-register']);
  assert.equal(requirement.status, 'not_met');
  assert.equal(requirement.is_blocking, true);
  assert.equal((result.eligibility_summary as Record<string, unknown>).blocking_issues, 1);
});

test('exact user fulfilled confirmation updates a stale model result', async () => {
  const prepared = await attach([], [{
    ...common, evidence_id: 'exact-register', title: 'Registerprüfung', requirement_id: 'REQ-001',
    status: 'verified', note: 'Aktueller Auszug geprüft', updated_at: '2026-08-05T20:02:00.000Z',
  }]);
  const context: ExecutionContext = new Map([
    ['attach-requirement-evidence', [{ json: prepared }]],
    ['load-requirements', [{ json: { requirements: sourceRequirements, eligibility_requirements: [] } }]],
  ]);
  const result = await run('apply-requirement-evidence-policy', {
    strategic_fit_score: 70,
    eligibility_requirements: [{
      id: 'REQ-001', status: 'needs_review', is_blocking: false, profile_evidence: [],
      assessment_reason: 'Noch offen',
    }],
  }, context);
  const requirement = (result.eligibility_requirements as Array<Record<string, unknown>>)[0];
  assert.equal(requirement.status, 'compliant');
  assert.deepEqual(requirement.requirement_evidence, ['exact-register']);
});

test('exact not-applicable confirmation clears only its requirement while pending evidence is ignored', async () => {
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
  assert.equal(register.status, 'compliant');
  assert.equal(register.applicability, 'not_applicable');
  assert.equal(register.is_blocking, false);
  assert.deepEqual(register.profile_evidence, ['requirement_evidence']);
  assert.equal(insurance.status, 'compliant');
  assert.equal(insurance.is_blocking, false);
  assert.equal(insurance.requirement_evidence, undefined);
  assert.equal((result.eligibility_summary as Record<string, unknown>).blocking_issues, 0);
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
