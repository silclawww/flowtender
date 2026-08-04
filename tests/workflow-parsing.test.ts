import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeExecutor } from '../lib/nodes/code.ts';
import { ifExecutor } from '../lib/nodes/control.ts';
import { httpRequestExecutor } from '../lib/nodes/http-request.ts';
import type { ExecutionContext, ExecutionItem } from '../types/execution.ts';

interface WorkflowCodeNode {
  id: string;
  type: string;
  config: {
    body?: string;
    body_input_field?: string;
    code?: string;
    condition?: string;
    continue_on_error?: boolean;
    process_each_item?: boolean;
    select?: string;
  };
  retry?: { max_attempts?: number };
}

function workflowNode(file: string, nodeId: string): WorkflowCodeNode {
  const workflow = JSON.parse(readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8')) as {
    nodes: WorkflowCodeNode[];
  };
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  assert.ok(node, `missing workflow node ${nodeId}`);
  return node;
}

function workflowCode(file: string, nodeId: string): string {
  const code = workflowNode(file, nodeId).config.code;
  assert.ok(code, `missing code node ${nodeId}`);
  return code;
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

function llmResponse(content: unknown): Record<string, unknown> {
  return { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] };
}

function textlessPdf(): Buffer {
  const stream = '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  const parts = ['%PDF-1.4\n'];
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(parts.join(''), 'ascii'));
    parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(parts.join(''), 'ascii');
  parts.push('xref\n0 5\n0000000000 65535 f\r\n');
  for (const offset of offsets) parts.push(`${String(offset).padStart(10, '0')} 00000 n\r\n`);
  parts.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(parts.join(''), 'ascii');
}

test('Stage 3 geocoding falls back to the company postal code when the exact locality is unknown', async () => {
  const originalFetch = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const query = url.searchParams.get('q') ?? '';
    queries.push(query);
    const match = query === '83661, Deutschland'
      ? [{ lat: '47.682', lon: '11.574', display_name: '83661 Lenggries' }]
      : query === 'München, Deutschland'
        ? [{ lat: '48.137', lon: '11.576', display_name: 'München' }]
        : [];
    return new Response(JSON.stringify(match), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await codeExecutor.execute(
      { code: workflowCode('tender-stage3-evaluation.json', 'geocode-distance') },
      [{ json: {
        company_profile: { hq_postal_code: '83661', hq_city: 'Lenggries-Schlegldorf' },
        bauort: 'München',
      } }],
      new Map(),
    );
    assert.deepEqual(queries, [
      '83661 Lenggries-Schlegldorf, Deutschland',
      'München, Deutschland',
      '83661, Deutschland',
    ]);
    assert.equal(typeof result[0]?.[0]?.json.distance_km, 'number');
    const note = String(result[0]?.[0]?.json.distance_note);
    assert.match(note, /Fahrtstrecke geschätzt/);
    assert.ok(note.indexOf('Fahrtstrecke geschätzt') < note.indexOf('Luftlinie'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Stage 3 keeps distance informational and outside the evaluation prompt', () => {
  const body = workflowNode('tender-stage3-evaluation.json', 'evaluate-llm').config.body ?? '';

  assert.doesNotMatch(body, /\$json\.distance_(?:km|note)/);
  assert.doesNotMatch(body, /Entfernung über|Anfahrtskosten|Unterbringung|Logistikaufwand/);
});

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
  title: 'Sanierung der Lüftungsanlagen im Schulzentrum, Landkreis Rosenheim',
  buyer: 'Gemeinde Bad Heilbrunn',
  region: 'Bad Heilbrunn',
  deadline: '2026-10-15',
  trade_category: 'Kanalbau',
};

test('stage 1 PDF rejects a structurally valid no-text document before metadata extraction', async () => {
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => logged.push(values);
  try {
    await assert.rejects(
      () => codeExecutor.execute(
        { code: workflowCode('tender-stage1-pdf.json', 'extract-text') },
        [{ json: { file_data: textlessPdf().toString('base64') } }],
        new Map(),
      ),
      /PDF_TEXT_UNAVAILABLE/,
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(logged, [['PDF_TEXT_UNAVAILABLE']]);
});

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
    { choices: [{ message: { content: JSON.stringify({ ...validGaebMetadata, title: 'x'.repeat(201) }) } }] },
  ];

  for (const response of responses) {
    await assertLlmResponseFailsSafely('tender-stage1-gaeb.json', 'parse-metadata', response);
  }
});

test('stage 1 preserves every GAEB position across large multi-lot archives', async () => {
  const gaebFiles = [454, 454].map((count, lotIndex) => ({
    file: `lot-${lotIndex + 1}.X83`,
    metadata: { data_phase: '83' },
    bill_of_quantities: {
      total_items: count,
      entries: Array.from({ length: count }, (_, itemIndex) => ({
        type: 'item',
        position: `${lotIndex + 1}.${String(itemIndex + 1).padStart(4, '0')}`,
        short_text: `Lot ${lotIndex + 1} position ${itemIndex + 1}`,
        quantity: itemIndex + 1,
        unit: 'm',
        category_path: [`Los ${lotIndex + 1}`],
      })),
    },
  }));

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage1-gaeb.json', 'normalise') },
    [{ json: {
      tender_id: 'large-gaeb-tender',
      org_id: 'org-id',
      gaeb_files: gaebFiles,
      archive_summary: {},
      pdf_texts: {},
    } }],
    new Map(),
  );
  const output = result[0][0].json as {
    item_count: number;
    gaeb_positions: Array<{ id: string; category_path: string[] }>;
  };

  assert.equal(output.item_count, 908);
  assert.equal(output.gaeb_positions.length, 908);
  assert.deepEqual(output.gaeb_positions[0], {
    id: '1.0001',
    short_text: 'Lot 1 position 1',
    long_text: '',
    quantity: 1,
    unit: 'm',
    category_path: ['Los 1'],
    gaeb_phase: 83,
  });
  assert.equal(output.gaeb_positions.at(-1)?.id, '2.0454');
});

test('stage 1 GAEB preserves valid metadata and structural fields', async () => {
  assert.ok(validGaebMetadata.title.length > 60);
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

const validRequirement = {
  id: 'REQ-001',
  category: 'Zertifizierung',
  title: 'ISO 9001 erforderlich',
  description: 'Ein gültiges ISO-9001-Zertifikat ist mit dem Angebot vorzulegen.',
  is_critical: true,
  is_implicit: false,
  source_fragments: ['Nachweis eines gültigen Qualitätsmanagementsystems nach ISO 9001.'],
};

const completeRequirementsCoverage = (requirementCount = 2) => ({
  source_insufficient: false,
  source_truncated: false,
  source_char_count: 5_000,
  extracted_char_count: 5_000,
  source_char_limit: 12_000,
  requirement_count: requirementCount,
  requirement_limit: 25,
  requirement_limit_reached: false,
});

async function parseStage2Requirements(
  source: string | Record<string, unknown>,
  requirementCount: number,
) {
  const tender = typeof source === 'string' ? { pdf_text: source } : source;
  const preparedResult = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'prepare-extraction-text') },
    [{ json: {} }],
    new Map([['load-tender', [{ json: tender }]]]),
  );
  const prepared = preparedResult[0][0];
  const requirements = Array.from({ length: requirementCount }, (_, index) => ({
    ...validRequirement,
    id: `REQ-${String(index + 1).padStart(3, '0')}`,
  }));
  const parsedResult = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'parse-requirements') },
    [{ json: llmResponse(requirements) }],
    new Map([['prepare-extraction-text', [prepared]]]),
  );
  return { prepared: prepared.json, parsed: parsedResult[0][0].json, requirements };
}

test('stage 2 records complete source and below-limit requirement coverage', async () => {
  const sourceText = 'Vollständiger Ausschreibungstext mit ausreichend belastbarem Dokumentinhalt.';
  const { prepared, parsed, requirements } = await parseStage2Requirements(sourceText, 2);

  assert.equal(prepared.extraction_text, sourceText);
  assert.deepEqual(parsed, {
    requirements,
    requirements_coverage: {
      source_insufficient: false,
      source_truncated: false,
      source_char_count: sourceText.length,
      extracted_char_count: sourceText.length,
      source_char_limit: 12_000,
      requirement_count: 2,
      requirement_limit: 25,
      requirement_limit_reached: false,
    },
  });
  assert.doesNotMatch(JSON.stringify(parsed.requirements_coverage), /Ausschreibungstext/);
});

test('stage 2 distinguishes source truncation from the exact requirement output limit', async () => {
  const truncated = await parseStage2Requirements('x'.repeat(12_001), 1);
  assert.equal((truncated.prepared.extraction_text as string).length, 12_000);
  assert.equal((truncated.parsed.requirements_coverage as Record<string, unknown>).source_truncated, true);
  assert.equal((truncated.parsed.requirements_coverage as Record<string, unknown>).requirement_limit_reached, false);

  const saturated = await parseStage2Requirements('x'.repeat(50), 25);
  assert.equal((saturated.parsed.requirements_coverage as Record<string, unknown>).source_truncated, false);
  assert.equal((saturated.parsed.requirements_coverage as Record<string, unknown>).requirement_count, 25);
  assert.equal((saturated.parsed.requirements_coverage as Record<string, unknown>).requirement_limit_reached, true);
});

test('stage 2 rejects malformed requirement schemas', async () => {
  const invalidRequirements: unknown[] = [
    Array.from({ length: 26 }, (_, index) => ({ ...validRequirement, id: `REQ-${index + 1}` })),
    [{ ...validRequirement, category: 'Leistungsposition' }],
    [{ ...validRequirement, title: 'x'.repeat(201) }],
    [{ ...validRequirement, is_critical: 'true' }],
    [{ ...validRequirement, source_fragments: ['x'.repeat(2_001)] }],
    [validRequirement, { ...validRequirement }],
  ];

  for (const requirements of invalidRequirements) {
    await assertLlmResponseFailsSafely(
      'tender-stage2-requirements.json',
      'parse-requirements',
      llmResponse(requirements),
    );
  }
});

test('stage 2 preserves a valid requirements response exactly', async () => {
  const requirements = [validRequirement, {
    ...validRequirement,
    id: 'REQ-002',
    category: 'Sicherheit',
    title: 'Gefährdungsbeurteilung',
    is_critical: false,
    is_implicit: true,
    source_fragments: [],
  }];

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'parse-requirements') },
    [{ json: llmResponse(requirements) }],
    new Map([['prepare-extraction-text', [{ json: {
      requirements_coverage: {
        source_insufficient: false,
        source_truncated: false,
        source_char_count: 5_000,
        extracted_char_count: 5_000,
        source_char_limit: 12_000,
      },
    } }]]]),
  );

  assert.deepEqual(result, [[{ json: {
    requirements,
    requirements_coverage: completeRequirementsCoverage(),
  } }]]);
});

test('stage 2 normalizes harmless requirement representation differences', async () => {
  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'parse-requirements') },
    [{ json: llmResponse({ requirements: [{
      ...validRequirement,
      title: 'x'.repeat(120),
      source_fragments: validRequirement.source_fragments[0],
      confidence: 0.97,
    }] }) }],
    new Map([['prepare-extraction-text', [{ json: {
      requirements_coverage: {
        source_insufficient: false,
        source_truncated: false,
        source_char_count: 5_000,
        extracted_char_count: 5_000,
        source_char_limit: 12_000,
      },
    } }]]]),
  );

  assert.deepEqual(result[0][0].json.requirements, [{
    ...validRequirement,
    title: 'x'.repeat(120),
  }]);
});

test('stage 2 fails closed when workload classification JSON is invalid', async () => {
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { gaeb_positions: [{ id: 'position-1' }] } }]],
  ]);
  await assertInvalidJsonFailsSafely('tender-stage2-requirements.json', 'parse-workload', context);
});

const workloadPositions = [
  { id: 'position-1', short_text: 'Baustelle einrichten', unit: 'psch' },
  { id: 'position-2', short_text: 'Fertigteile liefern und montieren', unit: 'St' },
];

const workloadClassificationKey = (index: number) => `POS-${String(index + 1).padStart(3, '0')}`;

const validWorkload = [
  { id: workloadClassificationKey(0), type: 'eigen', reason: 'Typische Baustelleneinrichtung' },
  { id: workloadClassificationKey(1), type: 'gemischt', reason: 'Lieferung und Einbau' },
];

test('stage 2 uses the same bounded index classification keys in the request and parser', () => {
  const keyGenerator = "const classificationKey = (index) => 'POS-' + String(index + 1).padStart(3, '0');";
  assert.ok(workflowCode('tender-stage2-requirements.json', 'prepare-workload-chunks').includes(keyGenerator));
  assert.ok(workflowCode('tender-stage2-requirements.json', 'parse-workload').includes(keyGenerator));
  assert.equal(workloadClassificationKey(119), 'POS-120');
});

test('stage 2 prepares every source position as bounded globally keyed chunks', async () => {
  const positions = Array.from({ length: 908 }, (_, index) => ({
    id: `source-${index + 1}`,
    short_text: `Position ${index + 1}`,
    unit: index % 2 === 0 ? 'm' : 'St',
    category_path: [`Los ${index < 454 ? 1 : 2}`],
  }));
  const passthrough = { requirements: [validRequirement] };
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { trade_category: 'Kanalbau', gaeb_positions: positions } }]],
  ]);

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'prepare-workload-chunks') },
    [{ json: passthrough }],
    context,
  );
  const chunks = result[0].map(item => item.json as {
    chunk_index: number;
    chunk_count: number;
    positions: Array<{ id: string }>;
  });

  assert.equal(chunks.length, 8);
  assert.ok(chunks.every(chunk => chunk.positions.length <= 120));
  assert.ok(chunks.every((chunk, index) =>
    chunk.chunk_index === index && chunk.chunk_count === chunks.length));
  assert.deepEqual(chunks.flatMap(chunk => chunk.positions).map(position => position.id),
    positions.map((_, index) => workloadClassificationKey(index)));
  assert.equal(chunks[0].positions[0].id, 'POS-001');
  assert.equal(chunks[7].positions.at(-1)?.id, 'POS-908');
});

test('stage 2 opts chunk classification into bounded per-item transport', () => {
  const node = workflowNode('tender-stage2-requirements.json', 'classify-workload');
  assert.equal(node.config.process_each_item, true);
  assert.equal(node.config.body_input_field, 'request_body');
});

test('stage 2 combines bounded chunk responses and nested JSON fields without losing classifications', async () => {
  const positions = Array.from({ length: 121 }, (_, index) => ({
    id: `source-${index + 1}`,
    short_text: `Position ${index + 1}`,
    unit: 'St',
    quantity: 1,
    category_path: ['Los 1'],
  }));
  const baseContext: ExecutionContext = new Map([
    ['load-tender', [{ json: { trade_category: 'Kanalbau', gaeb_positions: positions } }]],
  ]);
  const prepared = (await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'prepare-workload-chunks') },
    [{ json: { requirements: [] } }],
    baseContext,
  ))[0];
  const responses = prepared.map((item, chunkIndex) => {
    const chunkPositions = item.json.positions as Array<{ id: string }>;
    const classifications = chunkPositions.map(position => ({
      id: position.id,
      type: 'eigen',
      reason: 'Typische Eigenleistung',
    }));
    const groups = [{
      id: 'GROUP-001',
      label: `Arbeitspaket ${chunkIndex + 1}`,
      kind: 'semantic',
      position_ids: chunkPositions.map(position => position.id),
      distinguishing_attributes: ['Los 1'],
      confidence: 0.9,
      rationale: 'Zusammenhängendes Arbeitspaket innerhalb des Modell-Chunks.',
    }];
    return { json: llmResponse({
      classifications: chunkIndex === 0 ? JSON.stringify(classifications) : classifications,
      groups: chunkIndex === 0 ? JSON.stringify(groups) : groups,
    }) };
  });
  const context = new Map(baseContext);
  context.set('prepare-workload-chunks', prepared);
  const combined = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'combine-workload-chunks') },
    responses,
    context,
  );
  const parsed = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'parse-workload') },
    combined[0],
    context,
  );
  const breakdown = parsed[0][0].json.value_breakdown as {
    grouping_status: string;
    mode: string;
    source_total: number;
    classified_total: number;
    unclassified_total: number;
    semantic_groups: Array<{ id: string }>;
  };

  assert.deepEqual({
    grouping_status: breakdown.grouping_status,
    mode: breakdown.mode,
    source_total: breakdown.source_total,
    classified_total: breakdown.classified_total,
    unclassified_total: breakdown.unclassified_total,
    group_ids: breakdown.semantic_groups.map(group => group.id),
  }, {
    grouping_status: 'needs_review',
    mode: 'chunked_needs_merge',
    source_total: 121,
    classified_total: 121,
    unclassified_total: 0,
    group_ids: ['CHUNK-01-GROUP-001', 'CHUNK-02-GROUP-001'],
  });
});

test('stage 2 accepts only an exact cross-chunk semantic merge', async () => {
  const positions = Array.from({ length: 121 }, (_, index) => ({
    id: `source-${index + 1}`,
    short_text: `Position ${index + 1}`,
    unit: 'm',
    quantity: 1,
    category_path: ['Los 1'],
  }));
  const positionIds = positions.map((_, index) => workloadClassificationKey(index));
  const existing = {
    requirements: [],
    value_breakdown: {
      semantic_groups: [{ id: 'candidate', position_ids: positionIds }],
      grouping_status: 'needs_review',
      grouped_total: 121,
      source_total: 121,
      mode: 'chunked_needs_merge',
    },
  };
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { gaeb_positions: positions } }]],
    ['parse-workload', [{ json: existing }]],
  ]);
  const mergedGroups = [{
    id: 'GROUP-001',
    label: 'Zusammenhängendes Gesamtpaket',
    kind: 'semantic',
    position_ids: positionIds,
    distinguishing_attributes: ['Los 1'],
    confidence: 0.91,
    rationale: 'Die Positionen bilden über die Modell-Chunks hinweg ein Arbeitspaket.',
  }];

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'apply-workload-merge') },
    [{ json: llmResponse({ groups: mergedGroups }) }],
    context,
  );
  const breakdown = result[0][0].json.value_breakdown as {
    semantic_groups: Array<{ source_positions: unknown[]; quantity_totals: unknown[] }>;
    grouping_status: string;
    grouped_total: number;
    mode: string;
  };

  assert.equal(breakdown.grouping_status, 'complete');
  assert.equal(breakdown.grouped_total, 121);
  assert.equal(breakdown.mode, 'chunked_complete');
  assert.equal(breakdown.semantic_groups[0].source_positions.length, 121);
  assert.deepEqual(breakdown.semantic_groups[0].quantity_totals, [{ unit: 'm', quantity: 121 }]);

  const fallback = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'apply-workload-merge') },
    [{ json: llmResponse({ groups: [{ ...mergedGroups[0], position_ids: ['UNKNOWN'] }] }) }],
    context,
  );
  assert.deepEqual(fallback, [[{ json: existing }]]);
});

test('stage 2 makes the semantic merge call only for complete multi-chunk candidates', async () => {
  const route = workflowNode('tender-stage2-requirements.json', 'route-workload-merge');
  const single = await ifExecutor.execute(
    route.config,
    [{ json: { value_breakdown: { mode: 'complete', grouping_status: 'complete' } } }],
    new Map(),
  );
  const multi = await ifExecutor.execute(
    route.config,
    [{ json: { value_breakdown: {
      mode: 'chunked_needs_merge',
      grouping_status: 'needs_review',
      semantic_groups: [{ id: 'candidate' }],
      grouped_total: 121,
      source_total: 121,
    } } }],
    new Map(),
  );

  assert.equal(single[0].length, 0);
  assert.equal(single[1].length, 1);
  assert.equal(multi[0].length, 1);
  assert.equal(multi[1].length, 0);
  assert.equal(
    workflowNode('tender-stage2-requirements.json', 'reconcile-workload-groups-llm')
      .config.continue_on_error,
    true,
  );
  assert.ok(workflowCode('tender-stage2-requirements.json', 'parse-summary')
    .includes("$('finalize-workload').first().json.value_breakdown"));
});

test('stage 2 rejects incomplete, duplicate, unknown, and malformed workload classifications', async () => {
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { gaeb_positions: workloadPositions } }]],
  ]);
  const invalidClassifications: unknown[] = [
    [validWorkload[0]],
    [validWorkload[0], { ...validWorkload[0] }],
    [validWorkload[0], { ...validWorkload[1], id: 'unknown-position' }],
    [validWorkload[0], { ...validWorkload[1], type: 'subcontracted' }],
    [validWorkload[0], { ...validWorkload[1], reason: 'x'.repeat(501) }],
    { positions: validWorkload, items: validWorkload },
  ];

  for (const classifications of invalidClassifications) {
    await assertLlmResponseFailsSafely(
      'tender-stage2-requirements.json',
      'parse-workload',
      llmResponse(classifications),
      context,
    );
  }
});

test('stage 2 preserves enriched workload output and summary for a valid wrapper response', async () => {
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { gaeb_positions: workloadPositions } }]],
  ]);
  const response = llmResponse({ positions: validWorkload });

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'parse-workload') },
    [{ json: response }],
    context,
  );

  const output = result[0][0].json as Record<string, unknown>;
  assert.deepEqual({ ...output, value_breakdown: undefined }, { ...response, value_breakdown: undefined });
  assert.deepEqual(output.value_breakdown, {
    summary: { eigen: 1, fremd: 0, liefer: 0, gemischt: 1, total: 2 },
    positions: [
      { ...workloadPositions[0], type: 'eigen', reason: 'Typische Baustelleneinrichtung' },
      { ...workloadPositions[1], type: 'gemischt', reason: 'Lieferung und Einbau' },
    ],
    semantic_groups: [],
    grouping_status: 'needs_review',
    grouped_total: 0,
    source_total: 2,
    classified_total: 2,
    unclassified_total: 0,
    mode: 'complete',
    classified_at: (output.value_breakdown as { classified_at: string }).classified_at,
  });
  assert.match((output.value_breakdown as { classified_at: string }).classified_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('stage 2 preserves LLM semantic groups while deriving source coverage and quantities', async () => {
  const positions = [
    { id: '01.001', short_text: 'Boden lösen', unit: 'm3', quantity: 12.5, category_path: ['Los 1'] },
    { id: '02.004', short_text: 'Boden laden', unit: 'm3', quantity: 7.5, category_path: ['Los 2'] },
    { id: '03.002', short_text: 'Rohr DN 200 verlegen', unit: 'm', quantity: 18, category_path: ['Entwässerung'] },
    { id: '03.003', short_text: 'Rohr DN 200 Sonderanschluss', unit: 'Sonder-EH', quantity: 2, category_path: ['Entwässerung'] },
  ];
  const classifications = positions.map((_, index) => ({
    id: workloadClassificationKey(index),
    type: 'eigen',
    reason: 'Typische Eigenleistung',
  }));
  const groups = [
    {
      id: 'GROUP-001',
      label: 'Boden lösen und laden',
      kind: 'semantic',
      position_ids: ['POS-001', 'POS-002'],
      distinguishing_attributes: ['Bodenaushub'],
      confidence: 0.94,
      rationale: 'Gleicher zusammenhängender Erdbau-Arbeitsschritt über zwei Lose.',
    },
    {
      id: 'GROUP-002',
      label: 'Rohrleitung DN 200',
      kind: 'semantic',
      position_ids: ['POS-003', 'POS-004'],
      distinguishing_attributes: ['DN 200'],
      confidence: 0.9,
      rationale: 'Eigenständiges Rohrpaket mit abweichender Einheit.',
    },
  ];
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { gaeb_positions: positions } }]],
  ]);

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'parse-workload') },
    [{ json: llmResponse({ classifications, groups }) }],
    context,
  );
  const breakdown = result[0][0].json.value_breakdown as {
    semantic_groups: unknown[];
    grouping_status: string;
    grouped_total: number;
  };

  assert.equal(breakdown.grouping_status, 'complete');
  assert.equal(breakdown.grouped_total, 4);
  assert.deepEqual(breakdown.semantic_groups, [
    {
      ...groups[0],
      source_positions: [
        { source_id: 'POS-001', id: '01.001', short_text: 'Boden lösen', category_path: ['Los 1'], unit: 'm3', quantity: 12.5 },
        { source_id: 'POS-002', id: '02.004', short_text: 'Boden laden', category_path: ['Los 2'], unit: 'm3', quantity: 7.5 },
      ],
      quantity_totals: [{ unit: 'm3', quantity: 20 }],
    },
    {
      ...groups[1],
      source_positions: [
        { source_id: 'POS-003', id: '03.002', short_text: 'Rohr DN 200 verlegen', category_path: ['Entwässerung'], unit: 'm', quantity: 18 },
        { source_id: 'POS-004', id: '03.003', short_text: 'Rohr DN 200 Sonderanschluss', category_path: ['Entwässerung'], unit: 'Sonder-EH', quantity: 2 },
      ],
      quantity_totals: [{ unit: 'm', quantity: 18 }, { unit: 'Sonder-EH', quantity: 2 }],
    },
  ]);
});

test('stage 2 discards untrusted semantic groups without losing valid classifications', async () => {
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { gaeb_positions: workloadPositions } }]],
  ]);
  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'parse-workload') },
    [{ json: llmResponse({
      classifications: validWorkload,
      groups: [{
        id: 'GROUP-001',
        label: 'Untrusted group',
        kind: 'semantic',
        position_ids: ['POS-001', 'UNKNOWN'],
        distinguishing_attributes: [],
        confidence: 0.8,
        rationale: 'Contains an unknown source reference.',
      }],
    }) }],
    context,
  );
  const breakdown = result[0][0].json.value_breakdown as {
    semantic_groups: unknown[];
    grouping_status: string;
    grouped_total: number;
    summary: { total: number };
  };

  assert.deepEqual(breakdown.semantic_groups, []);
  assert.equal(breakdown.grouping_status, 'needs_review');
  assert.equal(breakdown.grouped_total, 0);
  assert.equal(breakdown.summary.total, 2);
});

test('stage 2 workload parsing ignores safe extras and prompt-only reason length differences', async () => {
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { gaeb_positions: workloadPositions } }]],
  ]);
  const longReason = 'eins zwei drei vier fünf sechs sieben acht neun zehn elf';
  const response = llmResponse({
    positions: [
      { ...validWorkload[0], confidence: 0.98 },
      { ...validWorkload[1], reason: longReason, confidence: 0.91 },
    ],
    model_note: 'safe redundant field',
  });

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'parse-workload') },
    [{ json: response }],
    context,
  );
  const positions = (result[0][0].json.value_breakdown as {
    positions: Array<{ reason: string; confidence?: number }>;
  }).positions;

  assert.equal(positions[1].reason, longReason);
  assert.equal('confidence' in positions[0], false);
});

test('stage 2 records complete classification coverage across the former sample boundary', async () => {
  for (const sourceTotal of [120, 121]) {
    const positions = Array.from({ length: sourceTotal }, (_, index) => ({
      id: `lot-position-${index + 1}`,
      short_text: `Position ${index + 1}`,
      unit: 'St',
    }));
    const classifications = positions.map((_, index) => ({
      id: workloadClassificationKey(index),
      type: 'eigen',
      reason: 'Typische Eigenleistung',
    }));
    const context: ExecutionContext = new Map([
      ['load-tender', [{ json: { gaeb_positions: positions } }]],
    ]);

    const result = await codeExecutor.execute(
      { code: workflowCode('tender-stage2-requirements.json', 'parse-workload') },
      [{ json: llmResponse(classifications) }],
      context,
    );
    const breakdown = result[0][0].json.value_breakdown as {
      summary: { eigen: number; total: number };
      positions: unknown[];
      source_total: number;
      classified_total: number;
      unclassified_total: number;
      mode: string;
    };

    assert.deepEqual({
      source_total: breakdown.source_total,
      classified_total: breakdown.classified_total,
      unclassified_total: breakdown.unclassified_total,
      mode: breakdown.mode,
      summary_total: breakdown.summary.total,
      eigen_count: breakdown.summary.eigen,
      saved_positions: breakdown.positions.length,
    }, {
      source_total: sourceTotal,
      classified_total: sourceTotal,
      unclassified_total: 0,
      mode: sourceTotal === 120 ? 'complete' : 'chunked_needs_merge',
      summary_total: sourceTotal,
      eigen_count: sourceTotal,
      saved_positions: sourceTotal,
    });
  }
});

test('stage 2 classifies duplicate file-local position IDs independently and saves original IDs', async () => {
  const positions = [
    { id: '01.001', short_text: 'Los 1 Baustelle einrichten', unit: 'psch' },
    { id: '01.001', short_text: 'Los 2 Spezialleistung', unit: 'psch' },
  ];
  const classifications = [
    { id: workloadClassificationKey(0), type: 'eigen', reason: 'Baustelleneinrichtung' },
    { id: workloadClassificationKey(1), type: 'fremd', reason: 'Spezialisierte Fremdleistung' },
  ];
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { gaeb_positions: positions } }]],
  ]);

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'parse-workload') },
    [{ json: llmResponse(classifications) }],
    context,
  );
  const breakdown = result[0][0].json.value_breakdown as {
    summary: Record<string, number>;
    positions: Record<string, unknown>[];
  };

  assert.deepEqual(breakdown.summary, { eigen: 1, fremd: 1, liefer: 0, gemischt: 0, total: 2 });
  assert.deepEqual(breakdown.positions, [
    { ...positions[0], type: 'eigen', reason: 'Baustelleneinrichtung' },
    { ...positions[1], type: 'fremd', reason: 'Spezialisierte Fremdleistung' },
  ]);
});

test('stage 2 preserves the no-GAEB workload early exit without parsing the LLM response', async () => {
  const input = { choices: [{ message: { content: '{invalid json' } }], requirements: [validRequirement] };
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { gaeb_positions: [] } }]],
  ]);

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'parse-workload') },
    [{ json: input }],
    context,
  );

  assert.deepEqual(result, [[{ json: { ...input, value_breakdown: null } }]]);
});

test('stage 3 fails closed when the evaluation LLM returns invalid JSON', async () => {
  const context: ExecutionContext = new Map([
    ['load-requirements', [{ json: { id: 'tender-id' } }]],
  ]);
  await assertInvalidJsonFailsSafely('tender-stage3-evaluation.json', 'parse-evaluation', context);
  await assertInvalidJsonFailsSafely('tender-stage3-evaluation.json', 'inspect-evaluation', context);
});

const validEvaluation = {
  strategic_fit_score: 82,
  bid_recommendation: 'recommend_bid',
  rationale: 'Das Profil erfüllt die wesentlichen Anforderungen. Die Referenzen sind einschlägig.',
  strengths: ['Gültige ISO-9001-Zertifizierung', 'Einschlägige Referenzprojekte'],
  eligibility_summary: {
    compliant_count: 1,
    partial_count: 1,
    not_met_count: 0,
    blocking_issues: 0,
  },
  eligibility_requirements: [
    { id: 'REQ-001', status: 'compliant', is_blocking: false },
    { id: 'REQ-002', status: 'partial', is_blocking: false },
  ],
  risks: [
    { id: 'RISK-001', title: 'Knappes Zeitfenster', text: 'Die Kalkulationsphase ist kurz.', severity: 'medium', mitigation: 'Kalkulationsteam sofort einplanen.' },
    { id: 'RISK-002', title: 'Materialpreisrisiko', text: 'Preise können bis zur Ausführung steigen.', severity: 'low', mitigation: 'Preisbindung mit Lieferanten vereinbaren.' },
    { id: 'RISK-003', title: 'Nachweis noch offen', text: 'Ein Referenznachweis muss aktualisiert werden.', severity: 'medium', mitigation: 'Aktuellen Nachweis vor Abgabe anfordern.' },
  ],
  clarifications: [
    { id: 'CLAR-001', question: 'Bitte bestätigen Sie den vorgesehenen Ausführungsbeginn.', priority: 'high' },
    { id: 'CLAR-002', question: 'Welche Form ist für den Referenznachweis vorgesehen?', priority: 'medium' },
    { id: 'CLAR-003', question: 'Sind gleichwertige Zertifizierungen zugelassen?', priority: 'medium' },
  ],
};

const allCompliantEvaluation = {
  ...validEvaluation,
  eligibility_summary: { compliant_count: 2, partial_count: 0, not_met_count: 0, blocking_issues: 0 },
  eligibility_requirements: validEvaluation.eligibility_requirements.map((requirement) => ({
    ...requirement,
    status: 'compliant',
  })),
};

async function evaluateStage3(requirements: unknown, coverage: unknown) {
  const context: ExecutionContext = new Map([
    ['load-requirements', [{ json: {
      id: 'tender-id',
      requirements,
      requirements_coverage: coverage,
    } }]],
    ['geocode-distance', [{ json: { distance_km: null, distance_note: null } }]],
  ]);
  return codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
    [{ json: llmResponse(allCompliantEvaluation) }],
    context,
  );
}

function stage3Context(): ExecutionContext {
  return new Map([
    ['load-requirements', [{ json: {
      id: 'tender-id',
      requirements: [
        { id: 'REQ-001', description: 'Nachweis A', source_fragments: ['Quelle A'] },
        { id: 'REQ-002', description: 'Nachweis B', source_fragments: ['Quelle B'] },
      ],
      requirements_coverage: completeRequirementsCoverage(),
    } }]],
    ['geocode-distance', [{ json: { distance_km: 47.5, distance_note: '47,5 km zum Bauort' } }]],
  ]);
}

test('stage 3 routes one safe invalid draft through evidence-grounded reconciliation', async () => {
  const valid = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'inspect-evaluation') },
    [{ json: llmResponse(validEvaluation) }],
    stage3Context(),
  );
  assert.equal(valid[0][0].json.reconciliation_required, false);

  const invalidDraft = {
    ...validEvaluation,
    strategic_fit_score: '82',
    eligibility_requirements: [
      { id: 'REQ-001', status: 'fulfilled', is_blocking: false },
      { id: 'REQ-UNKNOWN', status: 'partial', is_blocking: false },
    ],
    ignored_model_note: 'must never be copied into the repair prompt',
  };
  const inspected = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'inspect-evaluation') },
    [{ json: llmResponse(invalidDraft) }],
    stage3Context(),
  );
  const output = inspected[0][0].json;
  assert.equal(output.reconciliation_required, true);
  assert.deepEqual(
    (output.reconciliation_findings as Array<{ path: string }>).map((finding) => finding.path),
    [
      'strategic_fit_score',
      'eligibility_requirements[0].status',
      'eligibility_requirements',
    ],
  );
  assert.equal(
    'ignored_model_note' in (output.reconciliation_candidate as Record<string, unknown>),
    false,
  );

  const workflow = JSON.parse(readFileSync(
    new URL('../workflows/tender-stage3-evaluation.json', import.meta.url),
    'utf8',
  )) as {
    nodes: WorkflowCodeNode[];
    edges: Array<{ from: string; from_output: number; to: string }>;
  };
  const repairNodes = workflow.nodes.filter((node) => node.id === 'reconcile-evaluation-llm');
  assert.equal(repairNodes.length, 1);
  assert.equal(repairNodes[0].retry?.max_attempts, 1);
  assert.match(repairNodes[0].config.body ?? '', /QUELLANFORDERUNGEN/);
  assert.match(repairNodes[0].config.body ?? '', /reconciliation_findings/);
  assert.match(repairNodes[0].config.body ?? '', /reconciliation_candidate/);
  assert.deepEqual(
    workflow.edges
      .filter((edge) => edge.from === 'route-evaluation-reconciliation')
      .map((edge) => [edge.from_output, edge.to])
      .sort((left, right) => Number(left[0]) - Number(right[0])),
    [[0, 'reconcile-evaluation-llm'], [1, 'parse-evaluation']],
  );

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const requests: Array<{ body?: string }> = [];
  process.env.GEMINI_API_KEY = 'test-key';
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push({ body: typeof init?.body === 'string' ? init.body : undefined });
    return new Response(JSON.stringify(llmResponse(validEvaluation)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const repairContext: ExecutionContext = new Map([
      ['prepare-context', [{ json: {
        company_profile: { name: 'Test GmbH' },
        bauort: 'München',
        value_breakdown_note: '50% Eigenleistung',
      } }]],
    ]);
    await httpRequestExecutor.execute(
      repairNodes[0].config as Record<string, unknown>,
      inspected[0],
      repairContext,
      { deadline: Date.now() + 5_000 },
    );
    assert.equal(requests.length, 1);
    const request = JSON.parse(requests[0].body ?? '{}') as {
      messages?: Array<{ content?: string }>;
      temperature?: number;
    };
    assert.equal(request.temperature, 0);
    assert.match(request.messages?.[1]?.content ?? '', /Quelle A/);
    assert.match(request.messages?.[1]?.content ?? '', /must_cover_source_ids_exactly_once/);
    assert.doesNotMatch(request.messages?.[1]?.content ?? '', /must never be copied/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalApiKey;
  }
});

test('stage 3 preserves valid judgments and marks only unresolved requirements for review', async () => {
  const initialCandidate = {
    ...validEvaluation,
    strategic_fit_score: 74,
    eligibility_requirements: [
      { id: 'REQ-001', status: 'compliant', is_blocking: false },
    ],
  };
  const repairedCandidate = {
    ...validEvaluation,
    strategic_fit_score: 'invalid',
    rationale: '',
    eligibility_requirements: [
      { id: 'REQ-001', status: 'compliant', is_blocking: false },
      { id: 'REQ-002', status: 'unclear', is_blocking: false },
    ],
  };
  const context: ExecutionContext = new Map([
    ...stage3Context(),
    ['inspect-evaluation', [{ json: {
      reconciliation_candidate: initialCandidate,
    } }]],
  ]);

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'build-review-fallback') },
    [{ json: {
      reconciliation_candidate: repairedCandidate,
      reconciliation_source_requirements: [
        { id: 'REQ-001', is_critical: false },
        { id: 'REQ-002', is_critical: true },
      ],
    } }],
    context,
  );
  const output = result[0][0].json;

  assert.equal(output.processing_status, 'complete');
  assert.equal(output.bid_recommendation, 'needs_review');
  assert.equal(output.strategic_fit_score, 74);
  assert.deepEqual(output.eligibility_summary, {
    compliant_count: 1,
    partial_count: 0,
    not_met_count: 0,
    needs_review_count: 1,
    blocking_issues: 0,
  });
  assert.deepEqual(output.eligibility_requirements, [
    { id: 'REQ-001', status: 'compliant', is_blocking: false },
    {
      id: 'REQ-002',
      status: 'needs_review',
      is_blocking: false,
      review_reason: 'Modellbewertung blieb nach einer Reparatur uneindeutig.',
    },
  ]);
  assert.equal(output.distance_km, 47.5);
});

test('stage 3 review fallback preserves a validated blocker and never schedules another model call', async () => {
  const context: ExecutionContext = new Map([
    ...stage3Context(),
    ['inspect-evaluation', [{ json: {
      reconciliation_candidate: {
        ...validEvaluation,
        eligibility_requirements: [
          { id: 'REQ-001', status: 'compliant', is_blocking: false },
          { id: 'REQ-002', status: 'not_met', is_blocking: true },
        ],
      },
    } }]],
  ]);
  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'build-review-fallback') },
    [{ json: {
      reconciliation_candidate: { eligibility_requirements: [] },
      reconciliation_source_requirements: [
        { id: 'REQ-001', is_critical: false },
        { id: 'REQ-002', is_critical: true },
      ],
    } }],
    context,
  );
  assert.equal(result[0][0].json.bid_recommendation, 'recommend_no_bid');

  const workflow = JSON.parse(readFileSync(
    new URL('../workflows/tender-stage3-evaluation.json', import.meta.url),
    'utf8',
  )) as {
    nodes: WorkflowCodeNode[];
    edges: Array<{ from: string; from_output: number; to: string }>;
  };
  assert.equal(workflow.nodes.filter((node) => node.id === 'reconcile-evaluation-llm').length, 1);
  assert.deepEqual(
    workflow.edges
      .filter((edge) => edge.from === 'route-repaired-evaluation')
      .map((edge) => [edge.from_output, edge.to])
      .sort((left, right) => Number(left[0]) - Number(right[0])),
    [[0, 'build-review-fallback'], [1, 'parse-evaluation']],
  );
});

test('stage 3 explicitly selects coverage with the requirement inputs', () => {
  const select = workflowNode('tender-stage3-evaluation.json', 'load-requirements').config.select;
  assert.ok(select?.split(',').map((column) => column.trim()).includes('requirements_coverage'));
});

test('stage 3 preserves recommendations only for complete valid coverage', async () => {
  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
    [{ json: llmResponse(validEvaluation) }],
    stage3Context(),
  );

  assert.equal(result[0][0].json.bid_recommendation, 'recommend_bid');
});

test('adequate actual source remains complete through the Stage 2 and 3 workflows', async () => {
  const sourceText = 'x'.repeat(50);
  const stage2 = await parseStage2Requirements(sourceText, 2);
  const result = await evaluateStage3(stage2.requirements, stage2.parsed.requirements_coverage);

  assert.equal(
    (stage2.parsed.requirements_coverage as Record<string, unknown>).source_insufficient,
    false,
  );
  assert.equal(result[0][0].json.bid_recommendation, 'recommend_bid');
});

test('Stage 2 hint fallback records insufficient actual source and forces Stage 3 review', async () => {
  const title = 'Brückensanierung Augsburg';
  const stage2 = await parseStage2Requirements({
    pdf_texts_extracted: {
      'ausführliches-leistungsverzeichnis-mit-langem-dateinamen.pdf': '',
    },
    title,
  }, 2);
  const result = await evaluateStage3(stage2.requirements, stage2.parsed.requirements_coverage);

  assert.equal(stage2.prepared.extraction_text, `Projekttitel: ${title}`);
  assert.equal(
    (stage2.parsed.requirements_coverage as Record<string, unknown>).source_insufficient,
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(stage2.parsed.requirements_coverage),
    /Brückensanierung|Projekttitel/,
  );
  assert.equal(result[0][0].json.bid_recommendation, 'needs_review');
});

test('Stage 2 excludes fragment separators when measuring actual source adequacy', async () => {
  const stage2 = await parseStage2Requirements({
    pdf_texts_extracted: Array.from({ length: 18 }, () => 'x'),
    title: 'Brückensanierung Augsburg',
  }, 2);
  const result = await evaluateStage3(stage2.requirements, stage2.parsed.requirements_coverage);

  assert.equal(
    (stage2.parsed.requirements_coverage as Record<string, unknown>).source_insufficient,
    true,
  );
  assert.equal(result[0][0].json.bid_recommendation, 'needs_review');
});

test('Stage 2 prefers an adequate PDF fallback over whitespace-only extracted fragments', async () => {
  const pdfText = 'Vollständiger Ausschreibungstext mit ausreichend belastbarem Dokumentinhalt.';
  const stage2 = await parseStage2Requirements({
    pdf_texts_extracted: ['  ', '\n\t'],
    pdf_text: pdfText,
  }, 2);
  const result = await evaluateStage3(stage2.requirements, stage2.parsed.requirements_coverage);

  assert.equal(stage2.prepared.extraction_text, pdfText);
  assert.equal(
    (stage2.parsed.requirements_coverage as Record<string, unknown>).source_insufficient,
    false,
  );
  assert.equal(result[0][0].json.bid_recommendation, 'recommend_bid');
});

test('stage 3 forces review for truncated, saturated, missing, or malformed coverage', async () => {
  const coverageVariants: unknown[] = [
    { ...completeRequirementsCoverage(), source_insufficient: true },
    { ...completeRequirementsCoverage(), source_truncated: true, source_char_count: 12_001, extracted_char_count: 12_000 },
    { ...completeRequirementsCoverage(25), requirement_limit_reached: true },
    undefined,
    { source_truncated: false, requirement_limit_reached: false },
    (() => {
      const legacyCoverage = { ...completeRequirementsCoverage() } as Record<string, unknown>;
      delete legacyCoverage.source_insufficient;
      return legacyCoverage;
    })(),
  ];

  for (const coverage of coverageVariants) {
    const tender: Record<string, unknown> = {
      id: 'tender-id',
      requirements: [{ id: 'REQ-001' }, { id: 'REQ-002' }],
    };
    if (coverage !== undefined) tender.requirements_coverage = coverage;
    const context: ExecutionContext = new Map([
      ['load-requirements', [{ json: tender }]],
      ['geocode-distance', [{ json: { distance_km: null, distance_note: null } }]],
    ]);
    const result = await codeExecutor.execute(
      { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
      [{ json: llmResponse(validEvaluation) }],
      context,
    );
    assert.equal(result[0][0].json.bid_recommendation, 'needs_review');
  }
});

test('stage 3 derives recommendation policy before applying a coverage override', async () => {
  const context: ExecutionContext = new Map([
    ['load-requirements', [{ json: {
      id: 'tender-id',
      requirements: [{ id: 'REQ-001' }, { id: 'REQ-002' }],
      requirements_coverage: { ...completeRequirementsCoverage(), source_insufficient: true },
    } }]],
  ]);
  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
    [{ json: llmResponse({ ...validEvaluation, strategic_fit_score: 70, bid_recommendation: 'needs_review' }) }],
    context,
  );
  assert.equal(result[0][0].json.bid_recommendation, 'needs_review');
});

test('stage 3 rejects unsafe evaluation schemas while ignoring redundant aggregates', async () => {
  const matchingDuplicateSummary = {
    compliant_count: 2,
    partial_count: 0,
    not_met_count: 0,
    blocking_issues: 0,
  };
  const invalidEvaluations: unknown[] = [
    { ...validEvaluation, strategic_fit_score: 82.5 },
    { ...validEvaluation, strategic_fit_score: 101 },
    { ...validEvaluation, rationale: 'x'.repeat(5_001) },
    { ...validEvaluation, strengths: Array.from({ length: 21 }, () => 'Stärke') },
    {
      ...validEvaluation,
      eligibility_requirements: Array.from({ length: 26 }, (_, index) => ({
        id: `REQ-${index + 1}`,
        status: 'compliant',
        is_blocking: false,
      })),
    },
    {
      ...validEvaluation,
      eligibility_summary: matchingDuplicateSummary,
      eligibility_requirements: [validEvaluation.eligibility_requirements[0], validEvaluation.eligibility_requirements[0]],
    },
    {
      ...validEvaluation,
      eligibility_requirements: [
        validEvaluation.eligibility_requirements[0],
        { ...validEvaluation.eligibility_requirements[1], id: 'REQ-UNKNOWN' },
      ],
    },
    {
      ...validEvaluation,
      risks: validEvaluation.risks.map((risk, index) => index === 0 ? { ...risk, severity: 'critical' } : risk),
    },
    {
      ...validEvaluation,
      clarifications: Array.from({ length: 9 }, (_, index) => ({
        ...validEvaluation.clarifications[0],
        id: `CLAR-${index + 1}`,
      })),
    },
    { ...validEvaluation, clarifications: [...validEvaluation.clarifications, ...validEvaluation.clarifications] },
    {
      ...validEvaluation,
      clarifications: validEvaluation.clarifications.map((clarification, index) =>
        index === 0 ? { ...clarification, priority: 'low' } : clarification),
    },
  ];

  for (const evaluation of invalidEvaluations) {
    await assertLlmResponseFailsSafely(
      'tender-stage3-evaluation.json',
      'parse-evaluation',
      llmResponse(evaluation),
      stage3Context(),
    );
  }
});

test('stage 3 rejects fabricated eligibility IDs when source requirements are empty or missing', async () => {
  const tenders = [
    { id: 'tender-id', requirements: [], requirements_coverage: completeRequirementsCoverage(0) },
    { id: 'tender-id', requirements_coverage: completeRequirementsCoverage(0) },
  ];

  for (const tender of tenders) {
    const context: ExecutionContext = new Map([
      ['load-requirements', [{ json: tender }]],
    ]);
    await assertLlmResponseFailsSafely(
      'tender-stage3-evaluation.json',
      'parse-evaluation',
      llmResponse(validEvaluation),
      context,
    );
  }
});

test('stage 3 rejects an otherwise valid evaluation that omits a known requirement ID', async () => {
  const incompleteEvaluation = {
    ...validEvaluation,
    eligibility_summary: {
      compliant_count: 1,
      partial_count: 0,
      not_met_count: 0,
      blocking_issues: 0,
    },
    eligibility_requirements: [validEvaluation.eligibility_requirements[0]],
  };

  await assertLlmResponseFailsSafely(
    'tender-stage3-evaluation.json',
    'parse-evaluation',
    llmResponse(incompleteEvaluation),
    stage3Context(),
  );
});

test('stage 3 marks an empty requirement extraction for manual review', async () => {
  const manualReview = {
    ...validEvaluation,
    bid_recommendation: 'needs_review',
    eligibility_summary: {
      compliant_count: 0,
      partial_count: 0,
      not_met_count: 0,
      blocking_issues: 0,
    },
    eligibility_requirements: [],
  };
  const context: ExecutionContext = new Map([
    ['load-requirements', [{ json: {
      id: 'tender-id',
      requirements: [],
      requirements_coverage: completeRequirementsCoverage(0),
    } }]],
    ['geocode-distance', [{ json: { distance_km: null, distance_note: null } }]],
  ]);

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
    [{ json: llmResponse(manualReview) }],
    context,
  );

  assert.equal(result[0][0].json.bid_recommendation, 'needs_review');
  assert.equal(result[0][0].json.processing_status, 'complete');
});

test('stage 3 derives conservative recommendations when critical eligibility is unresolved', async () => {
  const criticalContext: ExecutionContext = new Map([
    ['load-requirements', [{ json: {
      id: 'tender-id',
      requirements: [{ id: 'REQ-001', is_critical: true }, { id: 'REQ-002', is_critical: false }],
      requirements_coverage: completeRequirementsCoverage(),
    } }]],
  ]);
  const emptyContext: ExecutionContext = new Map([
    ['load-requirements', [{ json: {
      id: 'tender-id',
      requirements: [],
      requirements_coverage: completeRequirementsCoverage(0),
    } }]],
  ]);
  const emptyRecommendation = {
    ...validEvaluation,
    eligibility_summary: { compliant_count: 0, partial_count: 0, not_met_count: 0, blocking_issues: 0 },
    eligibility_requirements: [],
  };
  const criticalPartial = {
    ...validEvaluation,
    eligibility_requirements: [
      { id: 'REQ-001', status: 'partial', is_blocking: false },
      { id: 'REQ-002', status: 'compliant', is_blocking: false },
    ],
  };
  const hiddenBlocker = {
    ...validEvaluation,
    eligibility_summary: { compliant_count: 0, partial_count: 1, not_met_count: 1, blocking_issues: 0 },
    eligibility_requirements: [
      { id: 'REQ-001', status: 'not_met', is_blocking: false },
      { id: 'REQ-002', status: 'partial', is_blocking: false },
    ],
  };
  const ignoredBlocker = {
    ...hiddenBlocker,
    eligibility_summary: { ...hiddenBlocker.eligibility_summary, blocking_issues: 1 },
    eligibility_requirements: [
      { id: 'REQ-001', status: 'not_met', is_blocking: true },
      { id: 'REQ-002', status: 'partial', is_blocking: false },
    ],
  };

  for (const [evaluation, context, recommendation] of [
    [emptyRecommendation, emptyContext, 'needs_review'],
    [criticalPartial, criticalContext, 'needs_review'],
    [ignoredBlocker, criticalContext, 'recommend_no_bid'],
  ] as const) {
    const result = await codeExecutor.execute(
      { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
      [{ json: llmResponse(evaluation) }],
      context,
    );
    assert.equal(result[0][0].json.bid_recommendation, recommendation);
  }
  const hiddenBlockerResult = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
    [{ json: llmResponse(hiddenBlocker) }],
    criticalContext,
  );
  assert.equal(hiddenBlockerResult[0][0].json.bid_recommendation, 'recommend_no_bid');
  assert.equal(
    (hiddenBlockerResult[0][0].json.eligibility_requirements as Array<{ is_blocking: boolean }>)[0].is_blocking,
    true,
  );
});

test('stage 3 requires no-bid for blockers regardless of score or coverage override', async () => {
  const blockingEvaluation = {
    ...validEvaluation,
    eligibility_summary: {
      compliant_count: 1,
      partial_count: 0,
      not_met_count: 1,
      blocking_issues: 1,
    },
    eligibility_requirements: [
      { id: 'REQ-001', status: 'compliant', is_blocking: false },
      { id: 'REQ-002', status: 'not_met', is_blocking: true },
    ],
  };

  for (const [score, recommendation] of [
    [60, 'needs_review'],
    [70, 'recommend_bid'],
  ] as const) {
    const result = await codeExecutor.execute(
      { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
      [{ json: llmResponse({
        ...blockingEvaluation,
        strategic_fit_score: score,
        bid_recommendation: recommendation,
      }) }],
      stage3Context(),
    );
    assert.equal(result[0][0].json.bid_recommendation, 'recommend_no_bid');
  }

  const incompleteCoverageContext: ExecutionContext = new Map([
    ['load-requirements', [{ json: {
      id: 'tender-id',
      requirements: [{ id: 'REQ-001' }, { id: 'REQ-002' }],
      requirements_coverage: { ...completeRequirementsCoverage(), source_insufficient: true },
    } }]],
  ]);
  const incompleteResult = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
    [{ json: llmResponse({
      ...blockingEvaluation,
      strategic_fit_score: 70,
      bid_recommendation: 'recommend_bid',
    }) }],
    incompleteCoverageContext,
  );
  assert.equal(incompleteResult[0][0].json.bid_recommendation, 'recommend_no_bid');

  for (const score of [60, 70]) {
    const result = await codeExecutor.execute(
      { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
      [{ json: llmResponse({
        ...blockingEvaluation,
        strategic_fit_score: score,
        bid_recommendation: 'recommend_no_bid',
      }) }],
      stage3Context(),
    );
    assert.equal(result[0][0].json.strategic_fit_score, score);
    assert.equal(result[0][0].json.bid_recommendation, 'recommend_no_bid');
  }

  const incompleteCoverageVariants: unknown[] = [
    { ...completeRequirementsCoverage(), source_insufficient: true },
    {
      ...completeRequirementsCoverage(),
      source_truncated: true,
      source_char_count: 12_001,
      extracted_char_count: 12_000,
    },
    { source_insufficient: true },
    undefined,
  ];
  for (const coverage of incompleteCoverageVariants) {
    const tender: Record<string, unknown> = {
      id: 'tender-id',
      requirements: [{ id: 'REQ-001' }, { id: 'REQ-002' }],
    };
    if (coverage !== undefined) tender.requirements_coverage = coverage;
    const context: ExecutionContext = new Map([
      ['load-requirements', [{ json: tender }]],
      ['geocode-distance', [{ json: { distance_km: null, distance_note: null } }]],
    ]);
    const result = await codeExecutor.execute(
      { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
      [{ json: llmResponse({
        ...blockingEvaluation,
        strategic_fit_score: 60,
        bid_recommendation: 'recommend_no_bid',
      }) }],
      context,
    );
    assert.equal(result[0][0].json.bid_recommendation, 'recommend_no_bid');
  }
});

test('stage 3 derives score recommendations and aggregate counts deterministically', async () => {
  for (const [score, rawRecommendation, expectedRecommendation] of [
    [49, 'recommend_bid', 'recommend_no_bid'],
    [50, 'recommend_no_bid', 'needs_review'],
    [69, 'recommend_bid', 'needs_review'],
    [70, 'needs_review', 'recommend_bid'],
  ] as const) {
    const result = await codeExecutor.execute(
      { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
      [{ json: llmResponse({
        ...validEvaluation,
        strategic_fit_score: score,
        bid_recommendation: rawRecommendation,
        eligibility_summary: { compliant_count: 0, partial_count: 0, not_met_count: 2, blocking_issues: 0 },
      }) }],
      stage3Context(),
    );
    assert.equal(result[0][0].json.bid_recommendation, expectedRecommendation);
    assert.deepEqual(result[0][0].json.eligibility_summary, validEvaluation.eligibility_summary);
  }
});

test('stage 3 ignores redundant fields and normalizes harmless model variation', async () => {
  const variableEvaluation = {
    strategic_fit_score: 70,
    rationale: validEvaluation.rationale,
    eligibility_requirements: validEvaluation.eligibility_requirements.map((requirement) => ({
      ...requirement,
      confidence: 0.95,
    })),
    strengths: JSON.stringify(validEvaluation.strengths),
    risks: validEvaluation.risks.slice(0, 2).map((risk, index) => ({
      ...risk,
      title: index === 0 ? 'x'.repeat(120) : risk.title,
      confidence: 0.9,
    })),
    extra_explanation: 'harmless redundant field',
  };

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
    [{ json: llmResponse(variableEvaluation) }],
    stage3Context(),
  );

  assert.equal(result[0][0].json.bid_recommendation, 'recommend_bid');
  assert.deepEqual(result[0][0].json.eligibility_summary, validEvaluation.eligibility_summary);
  assert.deepEqual(result[0][0].json.eligibility_requirements, validEvaluation.eligibility_requirements);
  assert.equal((result[0][0].json.risks as Array<{ title: string }>)[0].title.length, 120);
  assert.deepEqual(result[0][0].json.clarifications, []);
  assert.equal('extra_explanation' in result[0][0].json, false);
});

test('stage 3 accepts the exact score and recommendation boundaries', async () => {
  for (const [score, recommendation] of [
    [49, 'recommend_no_bid'],
    [50, 'needs_review'],
    [69, 'needs_review'],
    [70, 'recommend_bid'],
  ] as const) {
    const result = await codeExecutor.execute(
      { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
      [{ json: llmResponse({
        ...validEvaluation,
        strategic_fit_score: score,
        bid_recommendation: recommendation,
      }) }],
      stage3Context(),
    );
    assert.equal(result[0][0].json.strategic_fit_score, score);
    assert.equal(result[0][0].json.bid_recommendation, recommendation);
  }
});

test('stage 3 normalizes nested JSON strings and preserves a valid evaluation with distance fields', async () => {
  const nestedEvaluation = {
    ...validEvaluation,
    strengths: JSON.stringify(validEvaluation.strengths),
    eligibility_summary: JSON.stringify(validEvaluation.eligibility_summary),
    eligibility_requirements: JSON.stringify(validEvaluation.eligibility_requirements),
    risks: JSON.stringify(validEvaluation.risks),
    clarifications: JSON.stringify(validEvaluation.clarifications),
  };

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
    [{ json: llmResponse(nestedEvaluation) }],
    stage3Context(),
  );

  assert.deepEqual(result, [[{ json: {
    id: 'tender-id',
    ...validEvaluation,
    processing_status: 'complete',
    distance_km: 47.5,
    distance_note: '47,5 km zum Bauort',
  } }]]);
});
