import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeExecutor } from '../lib/nodes/code.ts';
import type { ExecutionContext, ExecutionItem } from '../types/execution.ts';

interface WorkflowCodeNode {
  id: string;
  type: string;
  config: { body?: string; code?: string; select?: string };
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
  source_truncated: false,
  source_char_count: 5_000,
  extracted_char_count: 5_000,
  source_char_limit: 12_000,
  requirement_count: requirementCount,
  requirement_limit: 25,
  requirement_limit_reached: false,
});

async function parseStage2Requirements(sourceText: string, requirementCount: number) {
  const preparedResult = await codeExecutor.execute(
    { code: workflowCode('tender-stage2-requirements.json', 'prepare-extraction-text') },
    [{ json: {} }],
    new Map([['load-tender', [{ json: { pdf_text: sourceText } }]]]),
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
  const sourceText = 'Vollständiger Ausschreibungstext';
  const { prepared, parsed, requirements } = await parseStage2Requirements(sourceText, 2);

  assert.equal(prepared.extraction_text, sourceText);
  assert.deepEqual(parsed, {
    requirements,
    requirements_coverage: {
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

  const saturated = await parseStage2Requirements('kurzer Quelltext', 25);
  assert.equal((saturated.parsed.requirements_coverage as Record<string, unknown>).source_truncated, false);
  assert.equal((saturated.parsed.requirements_coverage as Record<string, unknown>).requirement_count, 25);
  assert.equal((saturated.parsed.requirements_coverage as Record<string, unknown>).requirement_limit_reached, true);
});

test('stage 2 rejects malformed requirement schemas', async () => {
  const invalidRequirements: unknown[] = [
    { requirements: [validRequirement] },
    Array.from({ length: 26 }, (_, index) => ({ ...validRequirement, id: `REQ-${index + 1}` })),
    [{ ...validRequirement, category: 'Leistungsposition' }],
    [{ ...validRequirement, title: 'x'.repeat(61) }],
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
  assert.ok(workflowNode('tender-stage2-requirements.json', 'classify-workload').config.body?.includes(keyGenerator));
  assert.ok(workflowCode('tender-stage2-requirements.json', 'parse-workload').includes(keyGenerator));
  assert.equal(workloadClassificationKey(119), 'POS-120');
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
    [validWorkload[0], { ...validWorkload[1], reason: 'x'.repeat(201) }],
    [validWorkload[0], { ...validWorkload[1], reason: 'eins zwei drei vier fünf sechs sieben acht neun zehn elf' }],
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
    source_total: 2,
    classified_total: 2,
    unclassified_total: 0,
    mode: 'complete',
    classified_at: (output.value_breakdown as { classified_at: string }).classified_at,
  });
  assert.match((output.value_breakdown as { classified_at: string }).classified_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('stage 2 records complete and first-120-sample coverage at the paid-work boundary', async () => {
  for (const sourceTotal of [120, 121]) {
    const positions = Array.from({ length: sourceTotal }, (_, index) => ({
      id: `lot-position-${index + 1}`,
      short_text: `Position ${index + 1}`,
      unit: 'St',
    }));
    const classifications = positions.slice(0, 120).map((_, index) => ({
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
      classified_total: 120,
      unclassified_total: sourceTotal - 120,
      mode: sourceTotal === 120 ? 'complete' : 'first_120_sample',
      summary_total: 120,
      eigen_count: 120,
      saved_positions: 120,
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

function stage3Context(): ExecutionContext {
  return new Map([
    ['load-requirements', [{ json: {
      id: 'tender-id',
      requirements: [{ id: 'REQ-001' }, { id: 'REQ-002' }],
      requirements_coverage: completeRequirementsCoverage(),
    } }]],
    ['geocode-distance', [{ json: { distance_km: 47.5, distance_note: '47,5 km zum Bauort' } }]],
  ]);
}

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

test('stage 3 forces review for truncated, saturated, missing, or malformed coverage', async () => {
  const coverageVariants: unknown[] = [
    { ...completeRequirementsCoverage(), source_truncated: true, source_char_count: 12_001, extracted_char_count: 12_000 },
    { ...completeRequirementsCoverage(25), requirement_limit_reached: true },
    undefined,
    { source_truncated: false, requirement_limit_reached: false },
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

test('stage 3 rejects contradictory raw recommendations before applying a coverage override', async () => {
  const context: ExecutionContext = new Map([
    ['load-requirements', [{ json: {
      id: 'tender-id',
      requirements: [{ id: 'REQ-001' }, { id: 'REQ-002' }],
      requirements_coverage: { ...completeRequirementsCoverage(), source_truncated: true, source_char_count: 12_001, extracted_char_count: 12_000 },
    } }]],
  ]);
  await assertLlmResponseFailsSafely(
    'tender-stage3-evaluation.json',
    'parse-evaluation',
    llmResponse({ ...validEvaluation, strategic_fit_score: 70, bid_recommendation: 'needs_review' }),
    context,
  );
});

test('stage 3 rejects malformed evaluation schemas and inconsistent aggregates', async () => {
  const matchingDuplicateSummary = {
    compliant_count: 2,
    partial_count: 0,
    not_met_count: 0,
    blocking_issues: 0,
  };
  const invalidEvaluations: unknown[] = [
    { ...validEvaluation, strategic_fit_score: 82.5 },
    { ...validEvaluation, strategic_fit_score: 101 },
    { ...validEvaluation, bid_recommendation: 'bid' },
    { ...validEvaluation, rationale: 'x'.repeat(5_001) },
    { ...validEvaluation, strengths: Array.from({ length: 21 }, () => 'Stärke') },
    { ...validEvaluation, eligibility_summary: { ...validEvaluation.eligibility_summary, compliant_count: 2 } },
    { ...validEvaluation, eligibility_summary: { ...validEvaluation.eligibility_summary, blocking_issues: 1 } },
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
    { ...validEvaluation, risks: validEvaluation.risks.slice(0, 2) },
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

test('stage 3 rejects an unqualified recommendation when critical eligibility is unresolved', async () => {
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

  await assertLlmResponseFailsSafely(
    'tender-stage3-evaluation.json', 'parse-evaluation', llmResponse(emptyRecommendation), emptyContext,
  );
  for (const evaluation of [criticalPartial, hiddenBlocker, ignoredBlocker]) {
    await assertLlmResponseFailsSafely(
      'tender-stage3-evaluation.json', 'parse-evaluation', llmResponse(evaluation), criticalContext,
    );
  }

  const result = await codeExecutor.execute(
    { code: workflowCode('tender-stage3-evaluation.json', 'parse-evaluation') },
    [{ json: llmResponse({ ...criticalPartial, bid_recommendation: 'needs_review' }) }],
    criticalContext,
  );
  assert.equal(result[0][0].json.bid_recommendation, 'needs_review');
});

test('stage 3 rejects score and recommendation contradictions', async () => {
  for (const evaluation of [
    { ...validEvaluation, strategic_fit_score: 49, bid_recommendation: 'recommend_bid' },
    { ...validEvaluation, strategic_fit_score: 50, bid_recommendation: 'recommend_no_bid' },
    { ...validEvaluation, strategic_fit_score: 69, bid_recommendation: 'recommend_bid' },
    { ...validEvaluation, strategic_fit_score: 70, bid_recommendation: 'needs_review' },
  ]) {
    await assertLlmResponseFailsSafely(
      'tender-stage3-evaluation.json',
      'parse-evaluation',
      llmResponse(evaluation),
      stage3Context(),
    );
  }
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
