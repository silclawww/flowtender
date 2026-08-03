import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

type WorkflowNode = { id: string; type: string; config?: { data?: Record<string, unknown> | string } };
type Workflow = { nodes: WorkflowNode[] };

function workflow(name: string): Workflow {
  return JSON.parse(readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8')) as Workflow;
}

function savedFields(name: string, nodeId: string): string[] {
  const data = workflow(name).nodes.find((node) => node.id === nodeId)?.config?.data;
  assert.ok(data && typeof data === 'object', `${name}:${nodeId} must persist an explicit field map`);
  return Object.keys(data).sort();
}

test('successful Stage 2 and Stage 3 saves retain the complete pilot output contract', () => {
  assert.deepEqual(savedFields('tender-stage2-requirements.json', 'save-requirements'), [
    'processing_status', 'requirements', 'summary', 'value_breakdown',
  ]);
  assert.deepEqual(savedFields('tender-stage3-evaluation.json', 'save-evaluation'), [
    'bid_recommendation',
    'clarifications',
    'distance_km',
    'distance_note',
    'eligibility_requirements',
    'eligibility_summary',
    'processing_status',
    'rationale',
    'risks',
    'strategic_fit_score',
    'strengths',
  ]);
});

test('successful Stage 1 saves the validated metadata object without a lossy remap', () => {
  for (const name of ['tender-stage1-pdf.json', 'tender-stage1-gaeb.json']) {
    const save = workflow(name).nodes.find((node) => node.id === 'save');
    assert.equal(save?.type, 'supabase.upsert');
    assert.equal(save?.config?.data, 'auto_map');
  }
});
