import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStage3ShadowReadSource,
  runStage3ShadowFromSource,
} from '../lib/shadow/stage3-source.ts';
import { loadWorkflow } from '../lib/runner/loader.ts';
import {
  runStage3ShadowEvaluation,
  type RunStage3ShadowOptions,
  type Stage3ShadowArtifact,
} from '../lib/shadow/stage3.ts';
import type { NodeExecutor } from '../types/execution.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

const tenderId = '11111111-1111-4111-8111-111111111111';
const sourceOrgId = '22222222-2222-4222-8222-222222222222';
const profileOrgId = '33333333-3333-4333-8333-333333333333';
const completion = {
  id: '44444444-4444-4444-8444-444444444444',
  category: 'Sonstiges',
  title: 'Nachweis',
  status: 'verified',
  note: null,
  cert_reference: null,
  cert_expiry: null,
  updated_at: '2026-09-04T12:00:00.000Z',
};

test('shadow database source selects and scopes the three production-equivalent reads', async () => {
  const queries: Array<{ table: string; calls: unknown[][] }> = [];
  const results = [
    { data: { id: tenderId }, error: null },
    { data: { org_id: profileOrgId }, error: null },
    { data: [], error: null },
  ];
  const supabase = {
    from(table: string) {
      const query = { table, calls: [] as unknown[][] };
      const result = results[queries.length];
      queries.push(query);
      const builder = {
        select(...args: unknown[]) { query.calls.push(['select', ...args]); return builder; },
        eq(...args: unknown[]) { query.calls.push(['eq', ...args]); return builder; },
        not(...args: unknown[]) { query.calls.push(['not', ...args]); return builder; },
        like(...args: unknown[]) { query.calls.push(['like', ...args]); return builder; },
        order(...args: unknown[]) { query.calls.push(['order', ...args]); return builder; },
        limit(...args: unknown[]) { query.calls.push(['limit', ...args]); return Promise.resolve(result); },
        single() { query.calls.push(['single']); return Promise.resolve(result); },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  const source = createStage3ShadowReadSource(supabase);

  await source.tenderById(tenderId, sourceOrgId);
  await source.profileByOrg(profileOrgId);
  await source.tenderEvidenceById(sourceOrgId, tenderId);

  assert.deepEqual(queries, [
    {
      table: 'tenders',
      calls: [
        ['select', 'id,org_id,requirements,requirements_coverage,eligibility_requirements,region,value_breakdown,item_count'],
        ['eq', 'id', tenderId],
        ['eq', 'org_id', sourceOrgId],
        ['single'],
      ],
    },
    {
      table: 'company_profiles',
      calls: [['select', '*'], ['eq', 'org_id', profileOrgId], ['single']],
    },
    {
      table: 'org_requirement_completions',
      calls: [
        ['select', 'id,requirement_key,title,category,status,note,cert_reference,cert_expiry,updated_at'],
        ['eq', 'org_id', sourceOrgId],
        ['like', 'requirement_key', `tender:${tenderId}:requirement:%`],
        ['order', 'updated_at', { ascending: false }],
        ['limit', 25],
      ],
    },
  ]);
});

test('same-org shadow applies exact tender N/A without bypassing recommendation guards', async () => {
  const calls: unknown[][] = [];
  const capture: { forwarded?: RunStage3ShadowOptions } = {};
  const previousBlocker = [{ id: 'REQ-001', status: 'not_met', is_blocking: true }];
  const source = {
    tenderById: async (id: string, orgId: string) => {
      calls.push(['tender', id, orgId]);
      return {
        id,
        org_id: orgId,
        requirements: [{
          id: 'REQ-001',
          category: 'Zertifizierung',
          title: 'ISO 9001',
          description: 'ISO 9001 ist nachzuweisen.',
          is_critical: true,
          is_implicit: false,
          source_fragments: ['Formblatt 211'],
        }],
        requirements_coverage: {
          source_insufficient: false,
          source_truncated: false,
          source_char_count: 1000,
          extracted_char_count: 1000,
          source_char_limit: 200000,
          requirement_count: 1,
          requirement_limit: 25,
          requirement_limit_reached: false,
        },
        eligibility_requirements: previousBlocker,
        region: null, value_breakdown: null, item_count: 1,
      };
    },
    profileByOrg: async (orgId: string) => {
      calls.push(['profile', orgId]);
      return { org_id: orgId, name: 'Profile GmbH' };
    },
    tenderEvidenceById: async (orgId: string, id: string) => {
      calls.push(['tender-evidence', orgId, id]);
      return [{
        ...completion,
        id: '55555555-5555-4555-8555-555555555555',
        requirement_key: `tender:${id}:requirement:REQ-001`,
        status: 'not_applicable',
        note: 'Quellanforderung geprüft; nicht anwendbar.',
      }];
    },
  };
  const model: NodeExecutor = {
    async execute() {
      return [[{ json: { choices: [{ message: { content: JSON.stringify({
        strategic_fit_score: 70,
        score_components: {
          trade_scope_fit: 18,
          capacity_project_size_fit: 14,
          region_delivery_model_fit: 11,
          references_qualifications_fit: 17,
          execution_value_creation_fit: 10,
        },
        rationale: 'Der tender-spezifische Status muss gegen die Quellanforderung geprüft werden.',
        strengths: [],
        eligibility_requirements: [{
          id: 'REQ-001',
          status: 'needs_review',
          is_blocking: false,
          profile_evidence: [],
          assessment_reason: 'Der Nachweis ist noch offen.',
        }],
        risks: [],
        clarifications: [],
      }) } }] } }]];
    },
  };
  const runner = async (options: RunStage3ShadowOptions) => {
    capture.forwarded = options;
    return runStage3ShadowEvaluation({
      ...options,
      httpExecutor: model,
      generatedAt: '2026-09-04T12:30:00.000Z',
      runId: '66666666-6666-4666-8666-666666666666',
    });
  };

  const artifact = await runStage3ShadowFromSource({
    source,
    workflow: loadWorkflow('tender-stage3-evaluation'),
    tenderId,
    sourceOrgId,
    profileOrgId: sourceOrgId,
    profileLabel: 'exact-production',
    runner,
  });

  assert.deepEqual(calls, [
    ['tender', tenderId, sourceOrgId],
    ['profile', sourceOrgId],
    ['tender-evidence', sourceOrgId, tenderId],
  ]);
  assert.deepEqual(capture.forwarded?.tender.eligibility_requirements, previousBlocker);
  assert.deepEqual(capture.forwarded?.tenderRequirementEvidence, [{
    evidence_id: '55555555-5555-4555-8555-555555555555',
    requirement_id: 'REQ-001',
    title: completion.title,
    category: completion.category,
    status: 'not_applicable',
    note: 'Quellanforderung geprüft; nicht anwendbar.',
    cert_reference: null,
    cert_expiry: null,
    updated_at: completion.updated_at,
  }]);
  assert.equal(artifact.output.bid_recommendation, 'needs_review');
  assert.deepEqual(artifact.output.eligibility_requirements[0], {
    id: 'REQ-001',
    status: 'compliant',
    applicability: 'not_applicable',
    is_blocking: false,
    profile_evidence: ['requirement_evidence'],
    assessment_reason: 'Vom Nutzer als nicht zutreffend bestätigt: Quellanforderung geprüft; nicht anwendbar.: evidence_id=55555555-5555-4555-8555-555555555555',
    requirement_evidence: ['55555555-5555-4555-8555-555555555555'],
  });
});

test('cross-profile shadow excludes source tender decisions and never reads tender evidence', async () => {
  const calls: unknown[][] = [];
  const capture: { forwarded?: RunStage3ShadowOptions } = {};
  const previousBlocker = [{ id: 'REQ-001', status: 'not_met', is_blocking: true }];

  await runStage3ShadowFromSource({
    source: {
      tenderById: async (id, orgId) => {
        calls.push(['tender', id, orgId]);
        return {
          id,
          org_id: orgId,
          requirements: [{ id: 'REQ-001' }],
          eligibility_requirements: previousBlocker,
          item_count: 1,
        };
      },
      profileByOrg: async (orgId) => {
        calls.push(['profile', orgId]);
        return {
          org_id: orgId, name: 'Comparison GmbH', updated_at: '2026-09-04T12:00:00.000Z',
          certifications: ['ISO 9001'],
          certificate_evidence: [{ catalogue_id: 'iso-9001', reference: null, expires_at: null }],
        };
      },
      tenderEvidenceById: async () => {
        throw new Error('cross-profile tender evidence must not be read');
      },
    },
    workflow: { id: 'tender-stage3-evaluation', name: '', nodes: [], edges: [] },
    tenderId,
    sourceOrgId,
    profileOrgId,
    profileLabel: 'comparison',
    runner: async (options) => {
      capture.forwarded = options;
      return {} as Stage3ShadowArtifact;
    },
  });

  assert.deepEqual(calls, [
    ['tender', tenderId, sourceOrgId],
    ['profile', profileOrgId],
  ]);
  assert.equal('eligibility_requirements' in (capture.forwarded?.tender ?? {}), false);
  assert.equal(capture.forwarded?.tenderRequirementEvidence, undefined);
  assert.deepEqual(capture.forwarded?.profile.certificate_evidence, [
    { catalogue_id: 'iso-9001', reference: null, expires_at: null },
  ]);
});

test('same-org shadow forwards empty validated evidence snapshots safely', async () => {
  const capture: { forwarded?: RunStage3ShadowOptions } = {};
  await runStage3ShadowFromSource({
    source: {
      tenderById: async () => ({ id: tenderId, org_id: sourceOrgId, requirements: [], item_count: 0 }),
      profileByOrg: async () => ({ org_id: sourceOrgId, name: 'Profile GmbH' }),
      tenderEvidenceById: async () => [],
    },
    workflow: { id: 'tender-stage3-evaluation', name: '', nodes: [], edges: [] },
    tenderId,
    sourceOrgId,
    profileOrgId: sourceOrgId,
    profileLabel: 'exact-production',
    runner: async (options) => {
      capture.forwarded = options;
      return {} as Stage3ShadowArtifact;
    },
  });

  assert.deepEqual(capture.forwarded?.tenderRequirementEvidence, []);
});
