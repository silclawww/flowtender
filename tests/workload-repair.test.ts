import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

type Node = { id: string; type: string; config: { code?: string; condition?: string; body_input_field?: string } };
const workflow = JSON.parse(readFileSync(new URL('../workflows/tender-stage2-requirements.json', import.meta.url), 'utf8')) as { nodes: Node[]; edges: { from: string; from_output: number; to: string }[] };
const node = (id: string) => workflow.nodes.find((n) => n.id === id)!;
const positions = Array.from({ length: 6 }, (_, i) => ({ id: '01.0' + (i + 1), short_text: 'Pos ' + (i + 1), unit: 'm', category_path: ['A'] }));
const basis = { mode: 'company_rules', company_name: 'X', rules: [{ id: 'R-SUB', work_type: 'Markierung', outcome: 'sub' }, { id: 'R-OWN', work_type: 'Erdbau', outcome: 'own' }] };
const ok = (i: number) => ({ id: 'POS-00' + i, type: 'eigen', rule_id: null });
const combined = (classifications: unknown[]) => ({ choices: [{ message: { content: JSON.stringify({ classifications, groups: [] }) } }], classification_basis: basis });
const errors: string[] = [];
function run(id: string, json: unknown, context: Record<string, unknown>) {
  const log = { error: (line: string) => errors.push(line) };
  return new Function('$json', '$', 'console', node(id).config.code!)(json, (ref: string) => ({ first: () => ({ json: context[ref] }) }), log)[0].json;
}

test('valid classification passes through unchanged without a repair call', () => {
  const input = combined([1, 2, 3, 4, 5, 6].map(ok));
  const out = run('validate-workload', input, { 'load-tender': { gaeb_positions: positions } });
  assert.equal(out.workload_repair, null);
  assert.equal(out.repair_request, undefined);
  assert.equal(out.choices, input.choices);
});

test('missing, duplicate, unknown and rule-contradicting positions are re-asked with validator feedback', () => {
  errors.length = 0;
  const items = [ok(1), ok(2), ok(2), { id: 'POS-004', type: 'eigen', rule_id: 'R-SUB' }, { id: 'POS-005', type: 'fremd', rule_id: 'R-NOPE' }, ok(6), { id: 'POS-099', type: 'eigen', rule_id: null }];
  const out = run('validate-workload', combined(items), { 'load-tender': { gaeb_positions: positions } });
  assert.deepEqual(out.workload_repair.affected.sort(), ['POS-002', 'POS-003', 'POS-004', 'POS-005']);
  assert.deepEqual(out.workload_repair.kept.map((k: { id: string }) => k.id), ['POS-001', 'POS-006']);
  assert.deepEqual(out.workload_repair.counts, { missing: 1, duplicate: 1, unknown_id: 1, invalid_type: 0, unknown_rule: 1, rule_mismatch: 1 });
  const prompt = out.repair_request.messages[1].content as string;
  assert.match(prompt, /POS-004.*R-SUB hat outcome sub und verlangt type fremd/);
  assert.match(prompt, /fehlte in der Antwort/);
  assert.match(prompt, /kam mehrfach vor/);
  assert.deepEqual(out.repair_request.response_format.json_schema.schema.properties.classifications.items.properties.id.enum.sort(), ['POS-002', 'POS-003', 'POS-004', 'POS-005']);
  assert.ok(errors.some((line) => JSON.parse(line).event === 'WORKLOAD_VALIDATION'));
  // Diagnostics carry counts and position keys only, never position text.
  assert.ok(errors.every((line) => !line.includes('Pos ')));
});

test('repair merges into kept classifications; unresolved or still-contradicting answers fail the stage', () => {
  const base = run('validate-workload', combined([ok(1), ok(2), ok(3), { id: 'POS-004', type: 'eigen', rule_id: 'R-SUB' }, ok(6)]), { 'load-tender': { gaeb_positions: positions } });
  const answer = (classifications: unknown[]) => ({ choices: [{ message: { content: JSON.stringify({ classifications }) } }] });
  const merged = run('apply-workload-repair', answer([{ id: 'POS-004', type: 'fremd', rule_id: 'R-SUB' }, { id: 'POS-005', type: 'liefer', rule_id: null }]), { 'validate-workload': base });
  const result = JSON.parse(merged.choices[0].message.content);
  assert.deepEqual(result.classifications.map((c: { id: string; type: string }) => c.id + ':' + c.type), ['POS-001:eigen', 'POS-002:eigen', 'POS-003:eigen', 'POS-004:fremd', 'POS-005:liefer', 'POS-006:eigen']);
  assert.equal(merged.workload_repair.repaired_positions, 2);
  assert.throws(() => run('apply-workload-repair', answer([{ id: 'POS-004', type: 'eigen', rule_id: 'R-SUB' }, { id: 'POS-005', type: 'liefer', rule_id: null }]), { 'validate-workload': base }), /LLM_RESPONSE_INVALID_JSON/);
  assert.throws(() => run('apply-workload-repair', answer([{ id: 'POS-004', type: 'fremd', rule_id: 'R-SUB' }]), { 'validate-workload': base }), /LLM_RESPONSE_INVALID_JSON/);
});

test('repairing more than half of a large LV is not attempted; the stage fails as before', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: 'X' + i, short_text: 'P', unit: 'm' }));
  assert.throws(() => run('validate-workload', combined([ok(1)]), { 'load-tender': { gaeb_positions: many } }), /LLM_RESPONSE_INVALID_JSON/);
});

test('workflow routes validation through an optional single repair round into the unchanged parser', () => {
  const edges = workflow.edges.map((e) => e.from + ':' + e.from_output + '>' + e.to);
  for (const edge of ['combine-workload-chunks:0>validate-workload', 'validate-workload:0>route-workload-repair', 'route-workload-repair:0>repair-workload-llm', 'route-workload-repair:1>parse-workload', 'repair-workload-llm:0>apply-workload-repair', 'apply-workload-repair:0>parse-workload']) assert.ok(edges.includes(edge), edge);
  assert.ok(!edges.includes('combine-workload-chunks:0>parse-workload'));
  assert.equal(node('repair-workload-llm').config.body_input_field, 'repair_request');
  assert.match(node('parse-workload').config.code!, /validation_repair/);
});

test('extra non-position entries are dropped when every position is valid; repairs stay within 120 IDs', () => {
  const out = run('validate-workload', combined([1, 2, 3, 4, 5, 6].map(ok).concat([{ id: 'POS-077', type: 'eigen', rule_id: null }])), { 'load-tender': { gaeb_positions: positions } });
  assert.equal(out.workload_repair, null);
  assert.deepEqual(JSON.parse(out.choices[0].message.content).classifications.map((c: { id: string }) => c.id), ['POS-001', 'POS-002', 'POS-003', 'POS-004', 'POS-005', 'POS-006']);
  const many = Array.from({ length: 400 }, (_, i) => ({ id: 'X' + i, short_text: 'P', unit: 'm' }));
  const key = (i: number) => 'POS-' + String(i + 1).padStart(3, '0');
  const partial = Array.from({ length: 400 - 121 }, (_, i) => ({ id: key(i), type: 'eigen', rule_id: null }));
  assert.throws(() => run('validate-workload', combined(partial), { 'load-tender': { gaeb_positions: many } }), /LLM_RESPONSE_INVALID_JSON/);
  const fewer = Array.from({ length: 400 - 100 }, (_, i) => ({ id: key(i), type: 'eigen', rule_id: null }));
  assert.equal(run('validate-workload', combined(fewer), { 'load-tender': { gaeb_positions: many } }).workload_repair.affected.length, 100);
});
