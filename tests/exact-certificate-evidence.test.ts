import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeExecutor } from '../lib/nodes/code.ts';
import type { ExecutionContext } from '../types/execution.ts';

type Node = { id: string; config: { code?: string } };
const workflow = JSON.parse(readFileSync(
  new URL('../workflows/tender-stage3-evaluation.json', import.meta.url), 'utf8',
)) as { nodes: Node[] };
const code = (id: string) => {
  const value = workflow.nodes.find((node) => node.id === id)?.config.code;
  assert.ok(value, `missing code node ${id}`);
  return value;
};
async function run(id: string, input: Record<string, unknown>, context: ExecutionContext) {
  const result = await codeExecutor.execute({ code: code(id) }, [{ json: input }], context);
  return result[0][0].json;
}

const scoreMethodology = {
  version: 1,
  component_maxima: {
    trade_scope_fit: 25,
    capacity_project_size_fit: 20,
    region_delivery_model_fit: 15,
    references_qualifications_fit: 25,
    execution_value_creation_fit: 15,
  },
};

const requirements = [
  { id: 'REQ-CERT', title: 'ISO 9001', description: 'Gültiger Nachweis', category: 'Zertifizierung', is_critical: true, evidence_kind: 'certificate', certificate_catalogue_id: 'iso-9001' },
  { id: 'REQ-CERT-NO-ID', title: 'Unbestimmtes Zertifikat', description: '', category: 'Zertifizierung', is_critical: false, evidence_kind: 'certificate', certificate_catalogue_id: null },
  { id: 'REQ-FORM', title: 'Formblatt 124', description: '', category: 'Sonstiges', is_critical: false, evidence_kind: 'form', certificate_catalogue_id: null },
  { id: 'REQ-LEGACY', title: 'ISO 14001', description: '', category: 'Zertifizierung', is_critical: false },
];

async function prepare(profile: Record<string, unknown>, trigger: Record<string, unknown> = {}) {
  const context: ExecutionContext = new Map([
    ['load-requirements', [{ json: { id: 'tender-a', requirements, requirements_coverage: {} } }]],
    ['load-company-profile', [{ json: profile }]],
    ['trigger', [{ json: trigger }]],
  ]);
  const prepared = await run('prepare-context', profile, context);
  context.set('prepare-context', [{ json: prepared }]);
  const attached = await run('attach-requirement-evidence', prepared, context);
  return { attached, context };
}

test('exact current catalogue evidence alone deterministically satisfies routed certificates', async () => {
  const { attached, context } = await prepare({
    name: 'Beispiel GmbH', updated_at: '2026-09-05T08:00:00.000Z',
    certifications: ['ISO 9001', 'ISO 14001'],
    certificate_evidence: [
      { catalogue_id: ' iso-9001 ', reference: 'private-ref', expires_at: '2027-09-05' },
      { catalogue_id: 'not-needed', reference: null, expires_at: null },
    ],
  }, {
    company_requirement_evidence: [{
      evidence_id: 'legacy-slug', title: 'ISO 9001', category: 'Zertifizierung', status: 'verified',
      note: null, cert_reference: null, cert_expiry: null,
      updated_at: '2026-09-05T08:01:00.000Z', legacy_identity: true,
    }],
    tender_requirement_evidence: [],
  });

  assert.deepEqual(attached.exact_certificate_evidence, [{ catalogue_id: 'iso-9001', expires_at: '2027-09-05' }]);
  assert.equal(attached.profile_snapshot_at, '2026-09-05T08:00:00.000Z');
  assert.equal(attached.evidence_cutoff_at, '2026-09-05T08:00:00.000Z');
  const prompt = String(attached.requirements_json);
  assert.doesNotMatch(prompt, /private-ref|legacy-slug|not-needed/);
  assert.ok(Buffer.byteLength(prompt, 'utf8') < 4_000);

  context.set('attach-requirement-evidence', [{ json: attached }]);
  context.set('load-requirements', [{ json: { requirements, eligibility_requirements: [] } }]);
  const result = await run('apply-requirement-evidence-policy', {
    strategic_fit_score: 80,
    score_methodology: scoreMethodology,
    eligibility_requirements: requirements.map((item) => ({ id: item.id, status: 'compliant', is_blocking: false })),
  }, context);
  const byId = new Map((result.eligibility_requirements as Array<Record<string, unknown>>).map((item) => [item.id, item]));
  assert.equal(byId.get('REQ-CERT')?.status, 'compliant');
  assert.deepEqual(byId.get('REQ-CERT')?.requirement_evidence, ['certificate:iso-9001']);
  assert.equal(byId.get('REQ-CERT-NO-ID')?.status, 'needs_review');
  assert.equal(byId.get('REQ-FORM')?.status, 'needs_review');
  assert.equal(byId.get('REQ-LEGACY')?.status, 'compliant');
});

test('expired exact certificate stays review-only and exact tender N/A keeps prior source decision', async () => {
  const exactNa = {
    evidence_id: 'na-certificate', title: 'Unbestimmtes Zertifikat', category: 'Zertifizierung', status: 'not_applicable',
    note: 'Nach Quellprüfung nicht anwendbar', cert_reference: null, cert_expiry: null,
    updated_at: '2026-09-05T09:00:00.000Z', requirement_id: 'REQ-CERT-NO-ID',
  };
  const { attached, context } = await prepare({
    updated_at: '2026-09-05T08:00:00.000Z', certifications: ['ISO 9001'],
    certificate_evidence: [{ catalogue_id: 'iso-9001', reference: null, expires_at: '2020-01-01' }],
  }, { company_requirement_evidence: [], tender_requirement_evidence: [exactNa] });
  context.set('attach-requirement-evidence', [{ json: attached }]);
  context.set('load-requirements', [{ json: {
    requirements,
    eligibility_requirements: [{ id: 'REQ-CERT-NO-ID', status: 'not_met', is_blocking: false, assessment_reason: 'Quelle verlangt den Nachweis.' }],
  } }]);
  const result = await run('apply-requirement-evidence-policy', {
    strategic_fit_score: 80,
    eligibility_requirements: requirements.map((item) => ({ id: item.id, status: 'compliant', is_blocking: false })),
  }, context);
  const byId = new Map((result.eligibility_requirements as Array<Record<string, unknown>>).map((item) => [item.id, item]));
  assert.equal(byId.get('REQ-CERT')?.status, 'needs_review');
  assert.match(String(byId.get('REQ-CERT')?.assessment_reason), /abgelaufen/i);
  assert.equal(byId.get('REQ-CERT-NO-ID')?.status, 'not_met');
  assert.equal(attached.evidence_cutoff_at, '2026-09-05T09:00:00.000Z');
});

test('evaluation metadata stamps the authoritative profile snapshot', async () => {
  const context: ExecutionContext = new Map([
    ['attach-requirement-evidence', [{ json: {
      profile_snapshot_at: '2026-09-05T08:00:00.000Z',
      evidence_cutoff_at: '2026-09-05T09:00:00.000Z',
    } }]],
  ]);
  const result = await run('attach-evaluation-metadata', { eligibility_summary: {} }, context);
  assert.deepEqual(result.eligibility_summary, {
    evaluated_at: (result.eligibility_summary as Record<string, unknown>).evaluated_at,
    profile_snapshot_at: '2026-09-05T08:00:00.000Z',
    evidence_cutoff_at: '2026-09-05T09:00:00.000Z',
  });
});

test('structured certificate prompt growth is limited to needed requirement IDs', async () => {
  const routed = Array.from({ length: 25 }, (_, index) => ({
    id: `REQ-${index}`, title: `Zertifikat ${index}`, description: '', category: 'Zertifizierung',
    is_critical: false, evidence_kind: 'certificate', certificate_catalogue_id: `certificate-${index}`,
  }));
  const profile = {
    updated_at: '2026-09-05T08:00:00.000Z', certifications: [],
    certificate_evidence: Array.from({ length: 60 }, (_, index) => ({
      catalogue_id: `certificate-${index}`, reference: `private-${'x'.repeat(100)}`, expires_at: null,
    })),
  };
  const context: ExecutionContext = new Map([
    ['load-requirements', [{ json: { id: 'tender-a', requirements: routed } }]],
    ['load-company-profile', [{ json: profile }]],
  ]);
  const prepared = await run('prepare-context', profile, context);
  const promptEvidence = (prepared.company_profile as Record<string, unknown>).certificate_evidence;
  const bytes = Buffer.byteLength(JSON.stringify(promptEvidence), 'utf8');
  assert.equal((promptEvidence as unknown[]).length, 25);
  assert.ok(Math.ceil(bytes / 4) < 1_000, `certificate prompt delta was ${Math.ceil(bytes / 4)} estimated tokens`);
  assert.doesNotMatch(JSON.stringify(promptEvidence), /private-/);
});
