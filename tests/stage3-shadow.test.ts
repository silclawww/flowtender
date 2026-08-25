import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadWorkflow } from '../lib/runner/loader.ts';
import { runStage3ShadowEvaluation } from '../lib/shadow/stage3.ts';
import type { NodeExecutor } from '../types/execution.ts';

const tender = {
  id: '11111111-1111-4111-8111-111111111111',
  requirements: [
    { id: 'REQ-001', title: 'ISO 9001', is_critical: false },
    { id: 'REQ-002', title: 'Zwei vergleichbare Referenzprojekte', is_critical: true },
  ],
  requirements_coverage: {
    source_insufficient: false,
    source_truncated: false,
    source_char_count: 1000,
    extracted_char_count: 1000,
    source_char_limit: 12000,
    requirement_count: 2,
    requirement_limit: 25,
    requirement_limit_reached: false,
  },
  region: null,
  value_breakdown: null,
};

const profile = {
  id: 'private-profile-id',
  org_id: '22222222-2222-4222-8222-222222222222',
  user_id: 'private-user-id',
  name: 'Beispiel GmbH',
  founded_year: 1900,
  team_size: 75,
  annual_turnover_eur: 12_500_000,
  trades: ['Tiefbau'],
  regions: ['Bayern'],
  service_types: ['Öffentliche Auftraggeber'],
  certifications: ['PQ-VOB'],
  project_size_min_eur: 50_000,
  project_size_max_eur: 5_000_000,
  trade_capacities: [],
  insurances: {},
  policies: {},
  project_references: [],
  project_references_state: 'not_provided',
  onboarding_complete: true,
};

test('Stage 3 shadow executes the production evaluation path without any persistence node', async () => {
  let modelCalls = 0;
  const model: NodeExecutor = {
    async execute() {
      modelCalls++;
      return [[{ json: {
        choices: [{ message: { content: JSON.stringify({
          strategic_fit_score: 77,
          rationale: 'Die nachgewiesene Fachkompetenz passt, Referenznachweise sind noch zu prüfen.',
          strengths: ['Passendes Gewerk'],
          eligibility_requirements: [
            {
              id: 'REQ-001',
              status: 'compliant',
              is_blocking: false,
              profile_evidence: ['certifications'],
              assessment_reason: 'Die Zertifizierung ist im Profil hinterlegt.',
            },
            {
              id: 'REQ-002',
              status: 'needs_review',
              is_blocking: false,
              profile_evidence: [],
              assessment_reason: 'Referenznachweise sind noch nicht hinterlegt.',
            },
          ],
          risks: [{
            id: 'RISK-001',
            title: 'Referenzen offen',
            text: 'Referenznachweise sind nicht hinterlegt.',
            severity: 'medium',
            mitigation: 'Referenzen vor Abgabe ergänzen.',
          }],
          clarifications: [{
            id: 'CLAR-001',
            question: 'Welche Referenznachweise werden anerkannt?',
            priority: 'high',
          }],
        }) } }],
      } }]];
    },
  };

  const artifact = await runStage3ShadowEvaluation({
    workflow: loadWorkflow('tender-stage3-evaluation'),
    tender,
    profile,
    sourceOrgId: '33333333-3333-4333-8333-333333333333',
    profileOrgId: profile.org_id,
    profileLabel: 'willibald',
    httpExecutor: model,
    generatedAt: '2026-08-25T12:00:00.000Z',
    runId: '44444444-4444-4444-8444-444444444444',
  });

  assert.equal(modelCalls, 1);
  assert.equal(artifact.mode, 'read_only_shadow');
  assert.equal(artifact.customer_visible_mutations, 0);
  assert.deepEqual(artifact.execution.executed_nodes, [
    'prepare-context',
    'geocode-distance',
    'evaluate-llm',
    'inspect-evaluation',
    'parse-evaluation',
    'finalize-evaluation',
  ]);
  assert.equal(artifact.execution.executed_nodes.includes('save-evaluation'), false);
  assert.equal(artifact.input.company_profile.team_size, 75);
  assert.equal('id' in artifact.input.company_profile, false);
  assert.equal('org_id' in artifact.input.company_profile, false);
  assert.equal('user_id' in artifact.input.company_profile, false);
  assert.equal(artifact.output.strategic_fit_score, 77);
  assert.equal(artifact.output.bid_recommendation, 'needs_review');
  assert.deepEqual(artifact.output.eligibility_requirements[1], {
    id: 'REQ-002',
    status: 'needs_review',
    is_blocking: false,
    profile_evidence: ['project_references_state'],
    assessment_reason: 'Referenzprojekte wurden im Unternehmensprofil noch nicht hinterlegt.',
    review_reason: 'Referenzprojekte wurden im Unternehmensprofil noch nicht hinterlegt.',
  });
});

test('Stage 3 shadow reuses the bounded repair path without falling through to persistence', async () => {
  const initial = {
    strategic_fit_score: 77,
    rationale: 'Unvollständiger Entwurf.',
    strengths: [],
    eligibility_requirements: [
      { id: 'REQ-001', status: 'compliant', is_blocking: false },
    ],
    risks: [],
    clarifications: [],
  };
  const repaired = {
    strategic_fit_score: 76,
    rationale: 'Die Fachkompetenz passt; der Referenznachweis bleibt offen.',
    strengths: ['Passendes Gewerk'],
    eligibility_requirements: [
      {
        id: 'REQ-001',
        status: 'compliant',
        is_blocking: false,
        profile_evidence: ['certifications'],
        assessment_reason: 'Die Zertifizierung ist im Profil hinterlegt.',
      },
      {
        id: 'REQ-002',
        status: 'needs_review',
        is_blocking: false,
        profile_evidence: [],
        assessment_reason: 'Referenznachweise sind noch nicht hinterlegt.',
      },
    ],
    risks: [],
    clarifications: [],
  };
  const model: NodeExecutor = {
    async execute(config) {
      const candidate = String(config.body).includes('Du reparierst') ? repaired : initial;
      return [[{ json: {
        choices: [{ message: { content: JSON.stringify(candidate) } }],
      } }]];
    },
  };

  const artifact = await runStage3ShadowEvaluation({
    workflow: loadWorkflow('tender-stage3-evaluation'),
    tender,
    profile,
    sourceOrgId: '33333333-3333-4333-8333-333333333333',
    profileOrgId: profile.org_id,
    profileLabel: 'willibald',
    httpExecutor: model,
    generatedAt: '2026-08-25T12:00:00.000Z',
    runId: '55555555-5555-4555-8555-555555555555',
  });

  assert.equal(artifact.execution.model_calls, 2);
  assert.equal(artifact.execution.reconciliation_used, true);
  assert.equal(artifact.output.strategic_fit_score, 76);
  assert.deepEqual(artifact.execution.executed_nodes, [
    'prepare-context',
    'geocode-distance',
    'evaluate-llm',
    'inspect-evaluation',
    'reconcile-evaluation-llm',
    'inspect-repaired-evaluation',
    'parse-evaluation',
    'finalize-evaluation',
  ]);
  assert.equal(artifact.execution.executed_nodes.includes('save-evaluation'), false);
});

test('the shadow CLI has read-only database access and writes private non-overwriting artifacts', () => {
  const source = readFileSync('scripts/shadow-stage3.ts', 'utf8');
  assert.match(source, /\.from\('tenders'\)[\s\S]*\.select\(/);
  assert.match(source, /\.from\('company_profiles'\)[\s\S]*\.select\(/);
  assert.doesNotMatch(source, /\.(?:insert|update|upsert|delete|rpc)\s*\(/);
  assert.match(source, /outside the repository/);
  assert.match(source, /flag: 'wx'/);
  assert.match(source, /mode: 0o600/);
});
