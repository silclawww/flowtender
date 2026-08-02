import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('service-role configuration is confined to the server database client', () => {
  for (const path of [
    '../lib/auth.ts',
    '../lib/webhook-handler.ts',
    '../proxy.ts',
    '../app/api/flow/trigger/[workflowId]/route.ts',
    '../app/api/flow/webhook/[path]/route.ts',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/);
  }
});

test('the inspector treats stored values as text and Mermaid uses strict SVG sanitization', () => {
  const execution = readFileSync(new URL('../app/execution/[id]/page.tsx', import.meta.url), 'utf8');
  const mermaid = readFileSync(new URL('../app/components/MermaidDiagram.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(execution, /dangerouslySetInnerHTML|\.innerHTML/);
  assert.match(execution, /\{nodeRun\.stage\}/);
  assert.match(mermaid, /securityLevel:\s*['"]strict['"]/);
});
