import {
  companyRequirementEvidence,
  tenderRequirementEvidence,
  type CompanyRequirementEvidence,
  type TenderRequirementEvidence,
} from '../tenant-context.ts';
import {
  runStage3ShadowEvaluation,
  type RunStage3ShadowOptions,
  type Stage3ShadowArtifact,
} from './stage3.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkflowDefinition } from '../../types/workflow.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_COLUMNS = 'id,requirement_key,title,category,status,note,cert_reference,cert_expiry,updated_at';

export interface Stage3ShadowReadSource {
  tenderById: (tenderId: string, orgId: string) => Promise<Record<string, unknown> | null>;
  profileByOrg: (orgId: string) => Promise<Record<string, unknown> | null>;
  companyEvidenceByOrg: (orgId: string) => Promise<unknown[]>;
  tenderEvidenceById: (orgId: string, tenderId: string) => Promise<unknown[]>;
}

export function createStage3ShadowReadSource(
  supabase: SupabaseClient,
): Stage3ShadowReadSource {
  return {
    tenderById: async (tenderId, orgId) => {
      const { data, error } = await supabase
        .from('tenders')
        .select('id,org_id,requirements,requirements_coverage,eligibility_requirements,region,value_breakdown,item_count')
        .eq('id', tenderId)
        .eq('org_id', orgId)
        .single();
      if (error) throw new Error('Shadow tender unavailable');
      return data;
    },
    profileByOrg: async (orgId) => {
      const { data, error } = await supabase
        .from('company_profiles')
        .select('*')
        .eq('org_id', orgId)
        .single();
      if (error) throw new Error('Shadow profile unavailable');
      return data;
    },
    companyEvidenceByOrg: async (orgId) => {
      const { data, error } = await supabase
        .from('org_requirement_completions')
        .select(EVIDENCE_COLUMNS)
        .eq('org_id', orgId)
        .not('requirement_key', 'like', 'tender:%')
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) throw new Error('Shadow evidence unavailable');
      return data ?? [];
    },
    tenderEvidenceById: async (orgId, tenderId) => {
      const { data, error } = await supabase
        .from('org_requirement_completions')
        .select(EVIDENCE_COLUMNS)
        .eq('org_id', orgId)
        .like('requirement_key', `tender:${tenderId}:requirement:%`)
        .order('updated_at', { ascending: false })
        .limit(25);
      if (error) throw new Error('Shadow evidence unavailable');
      return data ?? [];
    },
  };
}

type ShadowRunner = (options: RunStage3ShadowOptions) => Promise<Stage3ShadowArtifact>;

export interface RunStage3ShadowFromSourceOptions {
  source: Stage3ShadowReadSource;
  workflow: WorkflowDefinition;
  tenderId: string;
  sourceOrgId: string;
  profileOrgId: string;
  profileLabel: string;
  runner?: ShadowRunner;
}

function completionFields(row: Record<string, unknown>) {
  return {
    evidence_id: row.id,
    title: row.title,
    category: row.category,
    status: row.status,
    note: row.note ?? null,
    cert_reference: row.cert_reference ?? null,
    cert_expiry: row.cert_expiry ?? null,
    updated_at: row.updated_at,
  };
}

function companyEvidence(rows: unknown[]): CompanyRequirementEvidence[] {
  if (rows.length > 50) throw new Error('SHADOW_COMPANY_EVIDENCE_INVALID');
  const shaped = rows.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const row = raw as Record<string, unknown>;
    if (typeof row.requirement_key !== 'string'
      || row.requirement_key.startsWith('tender:')
      || row.status === 'not_applicable') return [];
    return [{ ...completionFields(row), legacy_identity: true }];
  });
  return companyRequirementEvidence(shaped) ?? [];
}

function exactTenderEvidence(
  tenderId: string,
  rows: unknown[],
): TenderRequirementEvidence[] {
  if (rows.length > 25) throw new Error('SHADOW_TENDER_EVIDENCE_INVALID');
  const prefix = `tender:${tenderId}:requirement:`;
  const shaped = rows.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const row = raw as Record<string, unknown>;
    if (typeof row.requirement_key !== 'string' || !row.requirement_key.startsWith(prefix)) return [];
    const requirementId = row.requirement_key.slice(prefix.length);
    if (!requirementId) return [];
    return [{ ...completionFields(row), requirement_id: requirementId }];
  });
  return tenderRequirementEvidence(shaped) ?? [];
}

export async function runStage3ShadowFromSource(
  options: RunStage3ShadowFromSourceOptions,
): Promise<Stage3ShadowArtifact> {
  const {
    source, workflow, tenderId, sourceOrgId, profileOrgId, profileLabel,
    runner = runStage3ShadowEvaluation,
  } = options;
  if (![tenderId, sourceOrgId, profileOrgId].every((value) => UUID.test(value))) {
    throw new Error('SHADOW_SOURCE_SCOPE_INVALID');
  }
  const exactProductionMode = sourceOrgId.toLowerCase() === profileOrgId.toLowerCase();

  const [tender, profile, companyRows, tenderRows] = await Promise.all([
    source.tenderById(tenderId, sourceOrgId),
    source.profileByOrg(profileOrgId),
    source.companyEvidenceByOrg(profileOrgId),
    exactProductionMode
      ? source.tenderEvidenceById(sourceOrgId, tenderId)
      : Promise.resolve(undefined),
  ]);
  if (!tender || tender.id !== tenderId || tender.org_id !== sourceOrgId) {
    throw new Error('SHADOW_TENDER_NOT_FOUND');
  }
  if (!profile || profile.org_id !== profileOrgId) {
    throw new Error('SHADOW_PROFILE_NOT_FOUND');
  }
  const evaluationTender = exactProductionMode
    ? tender
    : Object.fromEntries(
      Object.entries(tender).filter(([key]) => key !== 'eligibility_requirements'),
    );

  return runner({
    workflow,
    tender: evaluationTender,
    profile,
    sourceOrgId,
    profileOrgId,
    profileLabel,
    companyRequirementEvidence: companyEvidence(companyRows),
    ...(exactProductionMode ? {
      tenderRequirementEvidence: exactTenderEvidence(tenderId, tenderRows ?? []),
    } : {}),
  });
}
