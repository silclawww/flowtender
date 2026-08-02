import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { svgToImageSource } from '../lib/safe-svg.ts';

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

test('the inspector treats stored values as text and Mermaid has no HTML sink', () => {
  const execution = readFileSync(new URL('../app/execution/[id]/page.tsx', import.meta.url), 'utf8');
  const mermaid = readFileSync(new URL('../app/components/MermaidDiagram.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(execution, /dangerouslySetInnerHTML|\.innerHTML/);
  assert.doesNotMatch(mermaid, /dangerouslySetInnerHTML|\.innerHTML/);
  assert.match(execution, /\{nodeRun\.stage\}/);
  assert.match(mermaid, /securityLevel:\s*['"]strict['"]/);
  assert.match(mermaid, /<img/);
});

test('hostile Mermaid SVG is rendered only as an opaque image source', () => {
  const hostile = '<svg onload="alert(1)"><script>alert(document.cookie)</script></svg>';
  const source = svgToImageSource(hostile);

  assert.match(source, /^data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(source, /<script|onload|document\.cookie/i);
  assert.equal(Buffer.from(source.split(',')[1], 'base64').toString('utf8'), hostile);
});
