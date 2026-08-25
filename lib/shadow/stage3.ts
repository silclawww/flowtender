import { createHash, randomUUID } from 'node:crypto';

import { codeExecutor } from '../nodes/code.ts';
import { httpRequestExecutor } from '../nodes/http-request.ts';
import type {
  ExecutionContext,
  ExecutionItem,
  NodeExecutor,
} from '../../types/execution.ts';
import type { WorkflowDefinition, WorkflowNode } from '../../types/workflow.ts';

const WORKFLOW_ID = 'tender-stage3-evaluation';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_LABEL = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface Stage3ShadowEvaluationOutput extends Record<string, unknown> {
  strategic_fit_score: number;
  bid_recommendation: string;
  eligibility_requirements: Array<Record<string, unknown>>;
}

export interface Stage3ShadowArtifact {
  schema_version: 1;
  mode: 'read_only_shadow';
  customer_visible_mutations: 0;
  run: {
    id: string;
    generated_at: string;
    source_tender_id: string;
    source_org_id: string;
    profile_org_id: string;
    profile_label: string;
  };
  workflow: {
    id: string;
    version: string | null;
    sha256: string;
  };
  input: {
    company_profile: Record<string, unknown>;
    requirements: unknown[];
    requirements_coverage: unknown;
    bauort: unknown;
    value_breakdown_note: unknown;
    sha256: string;
  };
  execution: {
    executed_nodes: string[];
    model_calls: number;
    reconciliation_used: boolean;
    reconciliation_findings: unknown[];
  };
  output: Stage3ShadowEvaluationOutput;
}

export interface RunStage3ShadowOptions {
  workflow: WorkflowDefinition;
  tender: Record<string, unknown>;
  profile: Record<string, unknown>;
  sourceOrgId: string;
  profileOrgId: string;
  profileLabel: string;
  httpExecutor?: NodeExecutor;
  generatedAt?: string;
  runId?: string;
  deadlineMs?: number;
}

function requiredNode(
  workflow: WorkflowDefinition,
  id: string,
  type: WorkflowNode['type'],
): WorkflowNode {
  const node = workflow.nodes.find((candidate) => candidate.id === id);
  if (!node || node.type !== type) {
    throw new Error(`SHADOW_WORKFLOW_NODE_INVALID:${id}`);
  }
  return node;
}

function firstItem(items: ExecutionItem[][], nodeId: string): ExecutionItem {
  const item = items[0]?.[0];
  if (!item) throw new Error(`SHADOW_WORKFLOW_EMPTY:${nodeId}`);
  return item;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new Error(`SHADOW_${field.toUpperCase()}_INVALID`);
}

export async function runStage3ShadowEvaluation(
  options: RunStage3ShadowOptions,
): Promise<Stage3ShadowArtifact> {
  const {
    workflow,
    tender,
    profile,
    sourceOrgId,
    profileOrgId,
    profileLabel,
    httpExecutor = httpRequestExecutor,
    generatedAt = new Date().toISOString(),
    runId = randomUUID(),
    deadlineMs = 300_000,
  } = options;

  if (workflow.id !== WORKFLOW_ID) throw new Error('SHADOW_WORKFLOW_INVALID');
  if (typeof tender.id !== 'string') throw new Error('SHADOW_TENDER_ID_INVALID');
  assertUuid(tender.id, 'tender_id');
  assertUuid(sourceOrgId, 'source_org_id');
  assertUuid(profileOrgId, 'profile_org_id');
  assertUuid(runId, 'run_id');
  if (!PROFILE_LABEL.test(profileLabel)) throw new Error('SHADOW_PROFILE_LABEL_INVALID');
  if (typeof profile.org_id === 'string' && profile.org_id !== profileOrgId) {
    throw new Error('SHADOW_PROFILE_ORG_MISMATCH');
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 600_000) {
    throw new Error('SHADOW_DEADLINE_INVALID');
  }

  const context: ExecutionContext = new Map([
    ['load-requirements', [{ json: tender }]],
    ['load-company-profile', [{ json: profile }]],
  ]);
  const executedNodes: string[] = [];
  const deadline = Date.now() + deadlineMs;
  let modelCalls = 0;

  const execute = async (
    nodeId: string,
    type: WorkflowNode['type'],
    input: ExecutionItem[],
    executor: NodeExecutor,
  ): Promise<ExecutionItem> => {
    const node = requiredNode(workflow, nodeId, type);
    executedNodes.push(nodeId);
    const output = await executor.execute(node.config, input, context, { deadline });
    const item = firstItem(output, nodeId);
    context.set(nodeId, output[0]);
    return item;
  };

  const runCode = (nodeId: string, input: ExecutionItem[]) =>
    execute(nodeId, 'code', input, codeExecutor);
  const runModel = async (nodeId: string, input: ExecutionItem[]) => {
    modelCalls++;
    return execute(nodeId, 'http_request', input, httpExecutor);
  };

  const profileItem = { json: profile };
  const prepared = await runCode('prepare-context', [profileItem]);
  const geocoded = await runCode('geocode-distance', [prepared]);
  const initialDraft = await runModel('evaluate-llm', [geocoded]);
  const inspectedInitial = await runCode('inspect-evaluation', [initialDraft]);
  const reconciliationFindings = Array.isArray(inspectedInitial.json.reconciliation_findings)
    ? inspectedInitial.json.reconciliation_findings : [];

  let finalCandidate: ExecutionItem;
  let reconciliationUsed = false;
  if (inspectedInitial.json.reconciliation_required === true) {
    reconciliationUsed = true;
    const repairedDraft = await runModel('reconcile-evaluation-llm', [inspectedInitial]);
    const inspectedRepair = await runCode('inspect-repaired-evaluation', [repairedDraft]);
    finalCandidate = inspectedRepair.json.reconciliation_required === true
      ? await runCode('build-review-fallback', [inspectedRepair])
      : await runCode('parse-evaluation', [repairedDraft]);
  } else {
    finalCandidate = await runCode('parse-evaluation', [initialDraft]);
  }
  const finalized = await runCode('finalize-evaluation', [finalCandidate]);
  const preparedJson = prepared.json;
  const evaluation = finalized.json as Stage3ShadowEvaluationOutput;
  if (!Number.isInteger(evaluation.strategic_fit_score)
    || !Array.isArray(evaluation.eligibility_requirements)) {
    throw new Error('SHADOW_EVALUATION_INVALID');
  }

  const input = {
    company_profile: preparedJson.company_profile as Record<string, unknown>,
    requirements: Array.isArray(preparedJson.requirements) ? preparedJson.requirements : [],
    requirements_coverage: tender.requirements_coverage ?? null,
    bauort: preparedJson.bauort ?? null,
    value_breakdown_note: preparedJson.value_breakdown_note ?? null,
  };

  return {
    schema_version: 1,
    mode: 'read_only_shadow',
    customer_visible_mutations: 0,
    run: {
      id: runId,
      generated_at: generatedAt,
      source_tender_id: tender.id,
      source_org_id: sourceOrgId,
      profile_org_id: profileOrgId,
      profile_label: profileLabel,
    },
    workflow: {
      id: workflow.id,
      version: workflow.version ?? null,
      sha256: sha256(workflow),
    },
    input: {
      ...input,
      sha256: sha256(input),
    },
    execution: {
      executed_nodes: executedNodes,
      model_calls: modelCalls,
      reconciliation_used: reconciliationUsed,
      reconciliation_findings: reconciliationFindings,
    },
    output: evaluation,
  };
}
