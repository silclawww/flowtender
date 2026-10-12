import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = JSON.parse(readFileSync(new URL('../workflows/tender-stage3-evaluation.json', import.meta.url), 'utf8')) as { nodes: { id: string; config: { code?: string; body?: string; select?: string } }[] };
const node = (id: string) => workflow.nodes.find((n) => n.id === id)!;

test('stage 3 feeds execution conditions to risks only and caps their severity at medium', () => {
  assert.match(node('load-requirements').config.select!, /execution_conditions/);
  assert.match(node('prepare-context').config.code!, /execution_conditions_json/);
  for (const id of ['evaluate-llm', 'reconcile-evaluation-llm']) {
    assert.match(node(id).config.body!, /AUSFÜHRUNGSBEDINGUNGEN: /);
    assert.match(node(id).config.body!, /niemals in eligibility_requirements|nie in eligibility_requirements/);
  }
  const code = node('apply-requirement-evidence-policy').config.code!;
  assert.match(code, /\/EXE-\/\.test\(risk\.id\) && risk\.severity === 'high' \? \{ \.\.\.risk, severity: 'medium' \}/);
});
