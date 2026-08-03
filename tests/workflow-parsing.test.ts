import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeExecutor } from '../lib/nodes/code.ts';
import type { ExecutionContext, ExecutionItem } from '../types/execution.ts';

interface WorkflowCodeNode {
  id: string;
  type: string;
  config: { code?: string };
}

function workflowCode(file: string, nodeId: string): string {
  const workflow = JSON.parse(readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8')) as {
    nodes: WorkflowCodeNode[];
  };
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  assert.ok(node?.config.code, `missing code node ${nodeId}`);
  return node.config.code;
}

async function assertInvalidJsonFailsSafely(
  file: string,
  nodeId: string,
  context: ExecutionContext = new Map(),
) {
  await assertLlmResponseFailsSafely(
    file,
    nodeId,
    { choices: [{ message: { content: '{invalid required json' } }] },
    context,
  );
}

async function assertLlmResponseFailsSafely(
  file: string,
  nodeId: string,
  response: Record<string, unknown>,
  context: ExecutionContext = new Map(),
) {
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => logged.push(values);
  const input: ExecutionItem[] = [{ json: response }];

  try {
    await assert.rejects(
      () => codeExecutor.execute({ code: workflowCode(file, nodeId) }, input, context),
      /LLM_RESPONSE_INVALID_JSON/,
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(logged, [['LLM_RESPONSE_INVALID_JSON']]);
}

const validPdfMetadata = {
  title: 'Brückensanierung Augsburg',
  summary: 'Die Ausschreibung umfasst die Sanierung einer Straßenbrücke.',
  buyer: 'Stadt Augsburg',
  region: 'Augsburg',
  deadline: '2026-09-30',
  category: 'Brückenbau',
  tender_type: 'works',
};

const validGaebMetadata = {
  title: 'Kanalsanierung Ortsmitte, Bad Heilbrunn',
  buyer: 'Gemeinde Bad Heilbrunn',
  region: 'Bad Heilbrunn',
  deadline: '2026-10-15',
  trade_category: 'Kanalbau',
};

test('stage 1 PDF fails closed when the metadata LLM returns invalid JSON', async () => {
  await assertInvalidJsonFailsSafely('tender-stage1-pdf.json', 'parse-metadata');
});

test('stage 1 PDF rejects malformed metadata schemas', async () => {
  const responses: Record<string, unknown>[] = [
    {},
    { choices: [{ message: { content: JSON.stringify([]) } }] },
    { choices: [{ message: { content: JSON.stringify({ ...validPdfMetadata, buyer: 42 }) } }] },
    { choices: [{ message: { content: JSON.stringify({ ...validPdfMetadata, deadline: '30.09.2026' }) } }] },
    { choices: [{ message: { content: JSON.stringify({ ...validPdfMetadata, tender_type: 'construction' }) } }] },
    { choices: [{ message: { content: JSON.stringify({ ...validPdfMetadata, summary: 'x'.repeat(2_001) }) } }] },
  ];

  for (const response of responses) {
    await assertLlmResponseFailsSafely('tender-stage1-pdf.json', 'parse-metadata', response);
  }
});

test('stage 1 PDF preserves valid metadata and source fields', async () => {
  const context: ExecutionContext = new Map([
    ['trigger', [{ json: {
      tender_id: 'pdf-tender-id',
      org_id: 'org-id',
      file_name: 'ausschreibung.pdf',
    } }]],
    ['extract-text', [{ json: { pdf_text: 'Extracted PDF text', page_count: 12 } }]],
  ]);
  const input: ExecutionItem[] = [{
    json: { choices: [{ message: { content: JSON.stringify(validPdfMetadata) } }] },
  }];

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage1-pdf.json', 'parse-metadata') },
    input,
    context,
  );

  assert.deepEqual(result, [[{ json: {
    id: 'pdf-tender-id',
    org_id: 'org-id',
    title: validPdfMetadata.title,
    buyer: validPdfMetadata.buyer,
    deadline: validPdfMetadata.deadline,
    summary: validPdfMetadata.summary,
    region: validPdfMetadata.region,
    category: validPdfMetadata.category,
    tendertype: validPdfMetadata.tender_type,
    source_type: 'pdf',
    source_filename: 'ausschreibung.pdf',
    pdf_text: 'Extracted PDF text',
    page_count: 12,
    processing_status: 'metadata_ready',
  } }]]);
});

test('stage 1 GAEB fails closed when the metadata LLM returns invalid JSON', async () => {
  await assertInvalidJsonFailsSafely('tender-stage1-gaeb.json', 'parse-metadata');
});

test('stage 1 GAEB rejects malformed metadata schemas', async () => {
  const responses: Record<string, unknown>[] = [
    {},
    { choices: [{ message: { content: JSON.stringify([]) } }] },
    { choices: [{ message: { content: JSON.stringify({ ...validGaebMetadata, buyer: ['Gemeinde'] }) } }] },
    { choices: [{ message: { content: JSON.stringify({ ...validGaebMetadata, deadline: '2026-02-30' }) } }] },
    { choices: [{ message: { content: JSON.stringify({ ...validGaebMetadata, title: 'x'.repeat(61) }) } }] },
  ];

  for (const response of responses) {
    await assertLlmResponseFailsSafely('tender-stage1-gaeb.json', 'parse-metadata', response);
  }
});

test('stage 1 GAEB preserves valid metadata and structural fields', async () => {
  const normalised = {
    id: 'gaeb-tender-id',
    org_id: 'org-id',
    gaeb_phase: 82,
    item_count: 17,
    lot_count: 2,
    source_type: 'gaeb',
    source_filename: 'leistungsverzeichnis.x82',
    has_plans: true,
    raw_gaeb_json: [{ project: { name: 'Brückenbau' } }],
    gaeb_positions: [{ id: '01.001', short_text: 'Baustelle einrichten' }],
    pdf_text: 'Serialized GAEB text',
  };
  const context: ExecutionContext = new Map([
    ['normalise', [{ json: normalised }]],
  ]);
  const input: ExecutionItem[] = [{
    json: { choices: [{ message: { content: JSON.stringify(validGaebMetadata) } }] },
  }];

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage1-gaeb.json', 'parse-metadata') },
    input,
    context,
  );

  assert.deepEqual(result, [[{ json: {
    id: normalised.id,
    org_id: normalised.org_id,
    title: validGaebMetadata.title,
    buyer: validGaebMetadata.buyer,
    region: validGaebMetadata.region,
    deadline: validGaebMetadata.deadline,
    trade_category: validGaebMetadata.trade_category,
    gaeb_phase: normalised.gaeb_phase,
    item_count: normalised.item_count,
    lot_count: normalised.lot_count,
    source_type: normalised.source_type,
    source_filename: normalised.source_filename,
    has_plans: normalised.has_plans,
    raw_gaeb_json: normalised.raw_gaeb_json,
    gaeb_positions: normalised.gaeb_positions,
    pdf_text: normalised.pdf_text,
    processing_status: 'metadata_ready',
  } }]]);
});

test('stage 2 fails closed when the requirements LLM returns invalid JSON', async () => {
  await assertInvalidJsonFailsSafely('tender-stage2-requirements.json', 'parse-requirements');
});

test('stage 2 fails closed when workload classification JSON is invalid', async () => {
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { gaeb_positions: [{ id: 'position-1' }] } }]],
  ]);
  await assertInvalidJsonFailsSafely('tender-stage2-requirements.json', 'parse-workload', context);
});

test('stage 3 fails closed when the evaluation LLM returns invalid JSON', async () => {
  const context: ExecutionContext = new Map([
    ['load-requirements', [{ json: { id: 'tender-id' } }]],
  ]);
  await assertInvalidJsonFailsSafely('tender-stage3-evaluation.json', 'parse-evaluation', context);
});
