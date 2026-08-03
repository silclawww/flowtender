import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PDFParse } from 'pdf-parse';

import { codeExecutor } from '../lib/nodes/code.ts';
import {
  buildExactJson,
  buildExactPdf,
  FLOW_JSON_MAX_BYTES,
  RAW_PDF_MAX_BYTES,
} from '../scripts/probe-deployed-limits.mjs';

test('deployed probe bodies have exact byte lengths and valid PDF/JSON semantics', async () => {
  const exactPdf = buildExactPdf(RAW_PDF_MAX_BYTES);
  const oversizedPdf = buildExactPdf(RAW_PDF_MAX_BYTES + 1);
  assert.equal(exactPdf.length, 3_000_000);
  assert.equal(oversizedPdf.length, 3_000_001);
  assert.match(exactPdf.toString('ascii', 0, 16), /^%PDF-1\.4/);
  assert.match(exactPdf.toString('ascii', -64), /%%EOF\n$/);

  const workflow = JSON.parse(readFileSync(
    new URL('../workflows/tender-stage1-pdf.json', import.meta.url),
    'utf8',
  )) as { nodes: Array<{ id: string; config: { code?: string } }> };
  const extractCode = workflow.nodes.find((node) => node.id === 'extract-text')?.config.code;
  assert.ok(extractCode);
  const output = await codeExecutor.execute(
    { code: extractCode },
    [{ json: { file_data: exactPdf.toString('base64') } }],
    new Map(),
  );
  assert.equal(output[0][0].json.page_count, 1);
  assert.match(String(output[0][0].json.pdf_text), /P0\.4 deployed boundary probe/);

  const parser = new PDFParse({ data: oversizedPdf });
  try {
    const parsed = await parser.getText();
    assert.equal(parsed.total, 1);
    assert.match(parsed.text, /P0\.4 deployed boundary probe/);
  } finally {
    await parser.destroy();
  }

  for (const size of [FLOW_JSON_MAX_BYTES, FLOW_JSON_MAX_BYTES + 1]) {
    const body = buildExactJson(size);
    assert.equal(body.length, size);
    const value = JSON.parse(body.toString('utf8')) as { probe?: unknown };
    assert.equal(typeof value.probe, 'string');
    assert.deepEqual(Object.keys(value), ['probe']);
  }
});
