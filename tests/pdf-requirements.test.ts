import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { pdfSourceBlocks, materializePdfSourceRefs, extractPdfChunks, pdfRequirementChunks, mergePdfExtractions, validatePdfExtraction, pdfExtractionKey, administrativeKind, type PdfNote } from '../lib/ingestion/pdf-requirements.ts';
import { cachedPdfExtraction, type PdfExtractionCache } from '../lib/ingestion/pdf-extraction-cache.ts';
import { createPdfRequirementsExecutor } from '../lib/nodes/pdf-requirements.ts';
import type { ExecutionContext, NodeExecutor } from '../types/execution.ts';
const org = '8218c886-b279-4c30-a408-79acf74f537b';
const catalogue = { version: 1, entries: [{ id: 'iso9001' }] };
const lines = [
  'Bitte senden Sie Ihr Angebot schriftlich oder per E-Mail bis 16.10.',
  'Die Bindefrist endet am 30.11.2026.',
  'Ausführungszeitraum: 08.03.2027 bis 17.09.2027.',
  'Verwenden Sie den Vordruck Rückantwort.',
  'Im Formblatt ist die Zertifizierung ISO 9001 nachzuweisen.',
  'Nach Betonage ist eine Aushärtezeit von 7 Tagen einzuhalten.',
];
const source = '[[SOURCE tender.pdf PAGE 1]]\n' + lines.join('\n');
const note = (index: number, title = lines[index]): PdfNote => ({ id: '', title, description: lines[index], source_fragments: ['[[SOURCE tender.pdf PAGE 1]] ' + lines[index]] });
const req = (index: number) => ({ ...note(index), category: 'Sonstiges', is_critical: true, is_implicit: false, evidence_kind: 'other', certificate_catalogue_id: null });
const raw = () => ({ requirements: lines.map((_, i) => req(i)), deadlines: [], documents: [] });
function memoryCache(): PdfExtractionCache {
  const entries = new Map<string, unknown>();
  return { async read(key) { return entries.get(key) ?? null; }, async create(key, value) { if (entries.has(key)) return 'conflict'; entries.set(key, value); return 'created'; } };
}
test('pure logistics route out; qualification in form and technical waiting period survive', () => {
  const result = validatePdfExtraction(raw(), source, catalogue);
  assert.equal(result.requirements.length, 2);
  assert.ok(result.requirements.some(v => v.description.includes('ISO 9001')));
  assert.ok(result.requirements.some(v => v.description.includes('Aushärtezeit')));
  assert.deepEqual(new Set(result.deadlines.map(v => v.kind)), new Set(['submission', 'binding', 'execution']));
  assert.equal(result.documents.length, 1);
  assert.equal(result.deadlines.find(v => v.kind === 'submission')?.description, lines[0]);
  assert.equal(administrativeKind({ ...note(0), title: 'Einreichungsweg', description: 'Einreichung schriftlich oder per E-Mail.' }), 'submission_method');
  assert.equal(administrativeKind({ ...note(4), title: 'Vordruck', description: 'Nachweis der Sachkunde im Vordruck' }), null);
  assert.equal(administrativeKind({ ...note(0), title: 'Festpreise', description: 'Festpreise für die gesamte Bauzeit.' }), null);
  assert.equal(administrativeKind({ ...note(0), title: 'Rückantwortformblatt bei Angebotsabgabe', description: 'Rückantwortformblatt ist bei Angebotsabgabe einzureichen.' }), 'document');
  assert.equal(administrativeKind({ ...note(0), title: 'Angebotsfrist im Formblatt', description: 'Angebotsfrist laut Formblatt: bis 16.10.' }), 'submission');
  assert.equal(administrativeKind({ ...note(0), title: 'Beschichtung', description: 'Beschichtung gemäß Formblatt dreilagig' }), null);
  assert.equal(administrativeKind({ ...note(0), title: 'Schweißarbeiten', description: 'Schweißarbeiten gemäß Vordruck' }), null);
});
test('quotes must come from stated page and cannot be paraphrased; implicit and invalid catalogue rejected', () => {
  for (const fragment of ['[[SOURCE tender.pdf PAGE 2]] ' + lines[4], '[[SOURCE invented.pdf PAGE 1]] ' + lines[4], '[[SOURCE tender.pdf PAGE 1]] ISO 9001 ist optional.']) {
    assert.throws(() => validatePdfExtraction({ requirements: [{ ...req(4), source_fragments: [fragment] }], deadlines: [], documents: [] }, source, catalogue), /PDF_EXTRACTION_INVALID/);
  }
  assert.throws(() => validatePdfExtraction({ ...raw(), requirements: [{ ...req(4), is_implicit: true }] }, source, catalogue));
  assert.throws(() => validatePdfExtraction({ ...raw(), requirements: [{ ...req(4), evidence_kind: 'certificate', certificate_catalogue_id: 'invented' }] }, source, catalogue));
});
test('content IDs and order are stable, duplicates collapse and canonical result revalidates identically', () => {
  const first = validatePdfExtraction(raw(), source, catalogue);
  const shuffled = raw(); shuffled.requirements.reverse(); shuffled.requirements.push(req(4));
  assert.deepEqual(first, validatePdfExtraction(shuffled, source, catalogue));
  assert.deepEqual(first, validatePdfExtraction(first, source, catalogue));
});
test('cache key scopes org/source/policy/catalogue and ignores tender IDs', () => {
  const key = pdfExtractionKey(org, source, catalogue);
  assert.equal(key, pdfExtractionKey(org, source.replace(/\n/g, '\r\n'), catalogue));
  assert.notEqual(key, pdfExtractionKey('4013e1c5-8f38-4c66-8085-58b09e1c9b33', source, catalogue));
  assert.notEqual(key, pdfExtractionKey(org, source + ' changed', catalogue));
  assert.notEqual(key, pdfExtractionKey(org, source, { ...catalogue, version: 2 }));
  assert.notEqual(key, pdfExtractionKey(org, source, catalogue, 'v-next'));
});
test('repeat hits skip model; concurrent misses return one persisted winner', async () => {
  const cache = memoryCache(), key = pdfExtractionKey(org, source, catalogue); let calls = 0;
  const extract = async () => { calls++; return raw(); };
  const first = await cachedPdfExtraction(cache, key, source, catalogue, extract);
  assert.deepEqual(await cachedPdfExtraction(cache, key, source, catalogue, extract), first);
  assert.equal(calls, 1);
  const concurrent = memoryCache(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const loser = cachedPdfExtraction(concurrent, key, source, catalogue, async () => { await gate; const value = raw(); value.requirements[4].title = 'A different model wording'; return value; });
  const winner = await cachedPdfExtraction(concurrent, key, source, catalogue, async () => raw());
  release(); assert.deepEqual(await loser, winner);
});
test('invalid model results never persist; cache errors and corrupt hits fail closed', async () => {
  let writes = 0, calls = 0;
  const cache: PdfExtractionCache = { async read() { return null; }, async create() { writes++; throw new Error('write failed'); } };
  await assert.rejects(cachedPdfExtraction(cache, 'key', source, catalogue, async () => ({})), /PDF_EXTRACTION_INVALID/);
  assert.equal(writes, 0);
  await assert.rejects(cachedPdfExtraction(cache, 'key', source, catalogue, async () => raw()), /write failed/);
  await assert.rejects(cachedPdfExtraction({ ...cache, async read() { return { version: 'old' }; } }, 'key', source, catalogue, async () => { calls++; return raw(); }), /CACHE_INVALID/);
  assert.equal(calls, 0);
});
test('GAEB delegates exact config and inputs; PDF single strict call then cache bypasses model', async () => {
  let calls = 0; const config = { body: 'legacy', auth_value: 'opaque' }; const inputs = [{ json: { a: 1 } }];
  const http: NodeExecutor = { async execute(actual, input) {
    calls++;
    if (actual.body === 'legacy') { assert.equal(actual, config); assert.equal(input, inputs); return [[{ json: { original: true } }]]; }
    const body = input[0].json.pdf_extraction_request as Record<string, unknown>;
    assert.equal(body.temperature, 0); assert.equal((body.response_format as Record<string, unknown>).type, 'json_schema');
    return [[{ json: { choices: [{ message: { content: JSON.stringify({ ...raw(), requirements: raw().requirements.map(({source_fragments: _fragments, ...item}) => ({ ...item, source_refs: ['S000001'] })) }) } }] } }]];
  } };
  const executor = createPdfRequirementsExecutor(() => memory, http), memory = memoryCache();
  assert.deepEqual(await executor.execute(config, inputs, new Map()), [[{ json: { original: true } }]]);
  const context: ExecutionContext = new Map([
    ['load-tender', [{ json: { source_type: 'pdf', org_id: org } }]],
    ['trigger', [{ json: { org_id: org } }]],
    ['prepare-extraction-text', [{ json: { extraction_text: source, certificate_catalogue: catalogue, requirements_coverage: { source_insufficient: false } } }]],
  ]);
  const first = await executor.execute(config, inputs, context);
  assert.deepEqual(await executor.execute(config, inputs, context), first); assert.equal(calls, 2);
});
test('workflow isolates PDF notes writes and preserves coverage and legacy Form216 path', async () => {
  const workflow = JSON.parse(readFileSync(new URL('../workflows/tender-stage2-requirements.json', import.meta.url), 'utf8'));
  const node = (id: string) => workflow.nodes.find((n: { id: string }) => n.id === id);
  assert.equal(node('extract-requirements-llm').type, 'pdf_requirements');
  const extraction = validatePdfExtraction(raw(), source, catalogue);
  const coverage = { source_insufficient: false, source_truncated: true, source_char_count: 1000010, extracted_char_count: 1000000, source_char_limit: 1000000 };
  const context: Record<string, unknown> = { 'load-tender': { source_type: 'pdf' }, 'prepare-extraction-text': { requirements_coverage: coverage } };
  const parse = new Function('$json', '$', node('parse-requirements').config.code);
  const result = parse({ pdf_extraction: extraction }, (id: string) => ({ first: () => ({ json: context[id] }) }))[0].json;
  assert.deepEqual(result.pdf_administrative, { version: 1, deadlines: extraction.deadlines, documents: extraction.documents });
  assert.equal(result.requirements_coverage.source_truncated, true);
  assert.ok(!('aufforderung_211' in node('save-requirements').config.data));
  assert.match(node('route-pdf-administrative').config.condition, /source_type === 'pdf'/);
  assert.match(node('parse-requirements').config.code, /REQ-F216-/);
});
test('raw output cap remains a review flag after admin routing, deduplication and cache validation', async () => {
  const capped = { ...raw(), requirements: Array.from({ length: 25 }, (_, i) => req(i % 6)) };
  const result = validatePdfExtraction(capped, source, catalogue);
  assert.equal(result.requirements.length, 2);
  assert.equal(result.output_limit_reached, true);
  assert.deepEqual(validatePdfExtraction(result, source, catalogue), result);
  const cache = memoryCache();
  const key = pdfExtractionKey(org, source, catalogue);
  await cachedPdfExtraction(cache, key, source, catalogue, async () => capped);
  assert.equal((await cachedPdfExtraction(cache, key, source, catalogue, async () => { throw new Error('must not run'); })).output_limit_reached, true);
  const workflow = JSON.parse(readFileSync(new URL('../workflows/tender-stage2-requirements.json', import.meta.url), 'utf8'));
  const parse = new Function('$json', '$', workflow.nodes.find((n: { id: string }) => n.id === 'parse-requirements').config.code);
  const context: Record<string, unknown> = { 'load-tender': { source_type: 'pdf' }, 'prepare-extraction-text': { requirements_coverage: { source_insufficient: false } } };
  const parsed = parse({ pdf_extraction: result }, (id: string) => ({ first: () => ({ json: context[id] }) }))[0].json;
  assert.equal(parsed.requirements_coverage.source_insufficient, true);
  assert.equal(parsed.requirements_coverage.requirement_count, 2);
  assert.equal(parsed.requirements_coverage.requirement_limit_reached, false);
});
test('page chunks preserve whole pages and repeat original marker only for oversized pages', () => {
  const marker1 = '[[SOURCE tender.pdf PAGE 1]]', marker2 = '[[SOURCE tender.pdf PAGE 2]]';
  const chunks = pdfRequirementChunks(marker1 + '\n' + 'a '.repeat(800) + '\n' + marker2 + '\n' + 'b '.repeat(800), 2000);
  assert.equal(chunks.length, 2); assert.ok(chunks[0].includes(marker1)); assert.ok(!chunks[0].includes(marker2)); assert.ok(chunks[1].startsWith(marker2));
  const oversized = pdfRequirementChunks(marker1 + '\n' + 'word '.repeat(1600), 2000);
  assert.ok(oversized.length > 2); assert.ok(oversized.every(v => v.startsWith(marker1) && v.length <= 2000));
  assert.throws(() => pdfRequirementChunks('unmarked'), /SOURCE_INVALID/);
});
test('chunk extraction collects every result with concurrency2 and sorts pages numerically', async () => {
  const pages = [1, 2, 11].map(page => `[[SOURCE tender.pdf PAGE ${page}]]\n${'padding '.repeat(160)}\nISO 9001 ist erforderlich.`);
  let active = 0, peak = 0, calls = 0;
  const result = await extractPdfChunks(pages.join('\n'), catalogue, async chunk => {
    active++; peak = Math.max(peak, active); calls++;
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    const refs = [...chunk.matchAll(/SOURCE_BLOCK_ID: (S\d+)/g)].map(match => match[1]);
    return { requirements: [{ ...req(4), source_refs: [refs[refs.length - 1]] }], deadlines: [], documents: [] };
  }, 2000);
  assert.equal(calls, 3); assert.equal(peak, 2); assert.equal(result.requirements.length, 3);
  assert.deepEqual(result.requirements.map(v => Number(v.source_fragments[0].match(/PAGE (\d+)/)![1])), [1, 2, 11]);
});
test('invalid chunk stops unscheduled work and never writes a partial snapshot', async () => {
  const pages = [1, 2, 3, 4].map(page => `[[SOURCE tender.pdf PAGE ${page}]]\n${'padding '.repeat(160)}\nISO 9001 ist erforderlich.`).join('\n');
  let calls = 0, writes = 0;
  const cache: PdfExtractionCache = { async read() { return null; }, async create() { writes++; return 'created'; } };
  await assert.rejects(cachedPdfExtraction(cache, 'key', pages, catalogue, () => extractPdfChunks(pages, catalogue, async () => { calls++; return {}; }, 2000)), /PDF_EXTRACTION_INVALID/);
  assert.equal(calls, 2); assert.equal(writes, 0);
});
test('merged chunk outputs deduplicate exact content and flag deterministic overflow', () => {
  const one = validatePdfExtraction({ ...raw(), requirements: [req(4)] }, source, catalogue);
  assert.equal(mergePdfExtractions([one, one]).requirements.length, 1);
  const many = Array.from({ length: 30 }, (_, index) => validatePdfExtraction({ ...raw(), requirements: [{ ...req(4), title: 'Qualification ' + index }] }, source, catalogue));
  const first = mergePdfExtractions(many), reversed = mergePdfExtractions([...many].reverse());
  assert.equal(first.requirements.length, 25); assert.equal(first.output_limit_reached, true); assert.deepEqual(first, reversed);
});
test('source block IDs materialize original multipage excerpts and retain split-word spelling', () => {
  const original = '[[SOURCE tender.pdf PAGE 16]]\nDie Prüfzeugnisse für Wasserbausteine sind\n[[SOURCE tender.pdf PAGE 17]]\nvor dem Einbau vorzulegen.\n[[SOURCE tender.pdf PAGE 21]]\nDie Geokunst-\nstoffen sind zu prüfen.';
  const blocks = pdfSourceBlocks(original);
  assert.equal(blocks.length, 3);
  const materialized = materializePdfSourceRefs({ requirements: [{ ...req(4), source_refs: [blocks[0].ref, blocks[1].ref, blocks[2].ref] }], deadlines: [], documents: [] }, blocks);
  const value = validatePdfExtraction(materialized, original, catalogue);
  assert.equal(value.requirements[0].source_fragments.length, 3);
  assert.ok(value.requirements[0].source_fragments.some(fragment => fragment.includes('Geokunst- stoffen')));
  assert.ok(value.requirements[0].source_fragments.some(fragment => fragment.includes('PAGE 17')));
  assert.throws(() => materializePdfSourceRefs({ requirements: [{ ...req(4), source_refs: ['S999999'] }], deadlines: [], documents: [] }, blocks), /PDF_EXTRACTION_INVALID/);
  assert.throws(() => materializePdfSourceRefs({ requirements: [{ ...req(4), source_refs: [] }], deadlines: [], documents: [] }, blocks), /PDF_EXTRACTION_INVALID/);
});
test('long source blocks remain bounded and stable without cross-page concatenation', () => {
  const original = '[[SOURCE tender.pdf PAGE 1]]\n' + 'A sentence with original wording.\n'.repeat(100) + '[[SOURCE tender.pdf PAGE 2]]\nA different page original sentence.';
  const blocks = pdfSourceBlocks(original);
  assert.deepEqual(blocks, pdfSourceBlocks(original));
  assert.equal(new Set(blocks.map(v => v.ref)).size, blocks.length);
  assert.ok(blocks.every(v => v.fragment.length <= 1050));
  for (const block of blocks) {
    const materialized = materializePdfSourceRefs({ requirements: [{ ...req(4), source_refs: [block.ref] }], deadlines: [], documents: [] }, blocks);
    assert.doesNotThrow(() => validatePdfExtraction(materialized, original, catalogue));
  }
});
