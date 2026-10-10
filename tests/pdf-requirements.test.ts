import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { pdfSourceBlocks, materializePdfSourceRefs, extractPdfChunks, pdfRequirementChunks, mergePdfExtractions, validatePdfExtraction, pdfExtractionKey, administrativeKind, hasExclusionLanguage, isStatutoryExclusionGround, PDF_REQUIREMENTS_PROMPT, PDF_REQUIREMENTS_VERSION, type PdfNote } from '../lib/ingestion/pdf-requirements.ts';
import { boundedPdfCacheOperation, createPdfExtractionCache, cachedPdfExtraction, type PdfExtractionCache } from '../lib/ingestion/pdf-extraction-cache.ts';
import { createPdfRequirementsExecutor } from '../lib/nodes/pdf-requirements.ts';
import { WorkflowDeadlineError } from '../lib/retry-errors.ts';
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
const raw = () => ({ requirements: lines.map((_, i) => req(i)) });
function memoryCache(): PdfExtractionCache {
  const entries = new Map<string, unknown>();
  return { async read(key) { return entries.get(key) ?? null; }, async create(key, value) { if (entries.has(key)) return 'conflict'; entries.set(key, value); return 'created'; } };
}
test('pure logistics route out; qualification in form and technical waiting period survive', () => {
  const result = validatePdfExtraction(raw(), source, catalogue);
  assert.equal(result.requirements.length, 2);
  assert.ok(result.requirements.some(v => v.description.includes('ISO 9001')));
  assert.ok(result.requirements.some(v => v.description.includes('Aushärtezeit')));
  assert.deepEqual(Object.keys(result).sort(), ['output_limit_reached', 'requirements']);
  assert.equal(administrativeKind({ ...note(0), title: 'Einreichungsweg', description: 'Einreichung schriftlich oder per E-Mail.' }), 'submission_method');
  assert.equal(administrativeKind({ ...note(0), title: 'Einreichungsweg', description: 'Schriftlich oder per E-Mail oder als DA84' }), 'submission_method');
  assert.equal(administrativeKind({ ...note(4), title: 'Vordruck', description: 'Nachweis der Sachkunde im Vordruck' }), null);
  assert.equal(administrativeKind({ ...note(0), title: 'Festpreise', description: 'Festpreise für die gesamte Bauzeit.' }), null);
  assert.equal(administrativeKind({ ...note(0), title: 'Rückantwortformblatt bei Angebotsabgabe', description: 'Rückantwortformblatt ist bei Angebotsabgabe einzureichen.' }), 'document');
  assert.equal(administrativeKind({ ...note(0), title: 'Angebotsfrist im Formblatt', description: 'Angebotsfrist laut Formblatt: bis 16.10.' }), 'submission');
  assert.equal(administrativeKind({ ...note(0), title: 'Beschichtung', description: 'Beschichtung gemäß Formblatt dreilagig' }), null);
  assert.equal(administrativeKind({ ...note(0), title: 'Schweißarbeiten', description: 'Schweißarbeiten gemäß Vordruck' }), null);
});
test('quotes must come from stated page and cannot be paraphrased; implicit rejected, inexact catalogue IDs nulled', () => {
  for (const fragment of ['[[SOURCE tender.pdf PAGE 2]] ' + lines[4], '[[SOURCE invented.pdf PAGE 1]] ' + lines[4], '[[SOURCE tender.pdf PAGE 1]] ISO 9001 ist optional.']) {
    assert.throws(() => validatePdfExtraction({ requirements: [{ ...req(4), source_fragments: [fragment] }] }, source, catalogue), /PDF_EXTRACTION_INVALID/);
  }
  assert.throws(() => validatePdfExtraction({ ...raw(), requirements: [{ ...req(4), is_implicit: true }] }, source, catalogue));
  // Inexact catalogue matches degrade to manual review instead of failing the extraction.
  for (const item of [{ evidence_kind: 'certificate', certificate_catalogue_id: 'invented' }, { evidence_kind: 'form', certificate_catalogue_id: 'iso9001' }])
    assert.equal(validatePdfExtraction({ requirements: [{ ...req(4), ...item }] }, source, catalogue).requirements[0].certificate_catalogue_id, null);
  assert.equal(validatePdfExtraction({ requirements: [{ ...req(4), evidence_kind: 'certificate', certificate_catalogue_id: 'iso9001' }] }, source, catalogue).requirements[0].certificate_catalogue_id, 'iso9001');
  assert.throws(() => validatePdfExtraction({ requirements: [{ ...req(4), certificate_catalogue_id: 42 }] }, source, catalogue), /PDF_EXTRACTION_INVALID/);
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
test('workflow saves requirements only, preserves existing metadata and legacy Form216 path', async () => {
  const workflow = JSON.parse(readFileSync(new URL('../workflows/tender-stage2-requirements.json', import.meta.url), 'utf8'));
  const node = (id: string) => workflow.nodes.find((n: { id: string }) => n.id === id);
  assert.equal(node('extract-requirements-llm').type, 'pdf_requirements');
  const extraction = validatePdfExtraction(raw(), source, catalogue);
  const coverage = { source_insufficient: false, source_truncated: true, source_char_count: 1000010, extracted_char_count: 1000000, source_char_limit: 1000000 };
  const context: Record<string, unknown> = { 'load-tender': { source_type: 'pdf' }, 'prepare-extraction-text': { requirements_coverage: coverage } };
  const parse = new Function('$json', '$', node('parse-requirements').config.code);
  const result = parse({ pdf_extraction: extraction }, (id: string) => ({ first: () => ({ json: context[id] }) }))[0].json;
  assert.equal(result.pdf_administrative, undefined);
  assert.equal(result.requirements_coverage.source_truncated, true);
  assert.ok(!('aufforderung_211' in node('save-requirements').config.data));
  assert.equal(node('route-pdf-administrative'), undefined);
  assert.equal(node('save-pdf-administrative'), undefined);
  assert.ok(!('required_documents' in node('save-requirements').config.data));
  assert.match(node('build-response-2').config.code, /required_documents: tender.required_documents/);
  assert.doesNotMatch(node('build-response-2').config.code, /pdf_administrative/);
  assert.match(node('parse-requirements').config.code, /REQ-F216-/);
});
test('raw output cap remains a review flag after admin routing, deduplication and cache validation', async () => {
  const capped = { ...raw(), requirements: Array.from({ length: 25 }, (_, i) => req(i % 6)) };
  const result = validatePdfExtraction(capped, source, catalogue, 25);
  assert.equal(result.requirements.length, 2);
  assert.equal(result.output_limit_reached, true);
  assert.deepEqual(validatePdfExtraction(result, source, catalogue), result);
  const cache = memoryCache();
  const key = pdfExtractionKey(org, source, catalogue);
  await cachedPdfExtraction(cache, key, source, catalogue, async () => result);
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
    return { requirements: [{ ...req(4), source_refs: [refs[refs.length - 1]] }] };
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
  const many = Array.from({ length: 60 }, (_, index) => validatePdfExtraction({ ...raw(), requirements: [{ ...req(4), title: 'Qualification ' + index }] }, source, catalogue));
  const first = mergePdfExtractions(many), reversed = mergePdfExtractions([...many].reverse());
  assert.equal(first.requirements.length, 50); assert.equal(first.output_limit_reached, true); assert.deepEqual(first, reversed);
});
test('source block IDs materialize original multipage excerpts and retain split-word spelling', () => {
  const original = '[[SOURCE tender.pdf PAGE 16]]\nDie Prüfzeugnisse für Wasserbausteine sind\n[[SOURCE tender.pdf PAGE 17]]\nvor dem Einbau vorzulegen.\n[[SOURCE tender.pdf PAGE 21]]\nDie Geokunst-\nstoffen sind zu prüfen.';
  const blocks = pdfSourceBlocks(original);
  assert.equal(blocks.length, 3);
  const materialized = materializePdfSourceRefs({ requirements: [{ ...req(4), source_refs: [blocks[0].ref, blocks[1].ref, blocks[2].ref] }] }, blocks);
  const value = validatePdfExtraction(materialized, original, catalogue);
  assert.equal(value.requirements[0].source_fragments.length, 3);
  assert.ok(value.requirements[0].source_fragments.some(fragment => fragment.includes('Geokunst- stoffen')));
  assert.ok(value.requirements[0].source_fragments.some(fragment => fragment.includes('PAGE 17')));
  assert.throws(() => materializePdfSourceRefs({ requirements: [{ ...req(4), source_refs: ['S999999'] }] }, blocks), /PDF_EXTRACTION_INVALID/);
  assert.throws(() => materializePdfSourceRefs({ requirements: [{ ...req(4), source_refs: [] }] }, blocks), /PDF_EXTRACTION_INVALID/);
});
test('long source blocks remain bounded and stable without cross-page concatenation', () => {
  const original = '[[SOURCE tender.pdf PAGE 1]]\n' + 'A sentence with original wording.\n'.repeat(100) + '[[SOURCE tender.pdf PAGE 2]]\nA different page original sentence.';
  const blocks = pdfSourceBlocks(original);
  assert.deepEqual(blocks, pdfSourceBlocks(original));
  assert.equal(new Set(blocks.map(v => v.ref)).size, blocks.length);
  assert.ok(blocks.every(v => v.fragment.length <= 1050));
  for (const block of blocks) {
    const materialized = materializePdfSourceRefs({ requirements: [{ ...req(4), source_refs: [block.ref] }] }, blocks);
    assert.doesNotThrow(() => validatePdfExtraction(materialized, original, catalogue));
  }
});
test('administrative routing never drops technical clauses; bidder-qualification scope is set by the prompt', () => {
  const clauses = [
    'Beschädigte Schilder sind vor Ausbau zu melden und mit Fotografie zu dokumentieren.',
    'Eignungsnachweis für Asphaltmischgut ist vorzulegen.',
    'Entsorgungs- und Verwertungsnachweise sind zu führen.',
    'Prüfprotokolle des Lastplattendruckversuchs sind vorzulegen.',
    'Bautagesberichte sind schriftlich zu führen.',
    'Messwerte sind elektronisch zu übermitteln.',
  ];
  const original = '[[SOURCE technical.pdf PAGE 1]]\n' + clauses.join('\n');
  const requirements = clauses.map(description => ({ ...req(4), title: description, description, source_fragments: ['[[SOURCE technical.pdf PAGE 1]] ' + description] }));
  const result = validatePdfExtraction({ requirements }, original, catalogue);
  assert.equal(result.requirements.length, 6);
  assert.deepEqual(validatePdfExtraction(result, original, catalogue), result);
});
test('short source block tails and short pages are never discarded', () => {
  const body = 'a'.repeat(999) + ' 17.';
  const original = '[[SOURCE original.pdf PAGE 1]]\n' + body + '\n[[SOURCE original.pdf PAGE 2]]\nVOB';
  const blocks = pdfSourceBlocks(original);
  assert.ok(blocks.some(v => v.fragment.endsWith('17.')));
  assert.equal(blocks[blocks.length - 1].fragment, '[[SOURCE original.pdf PAGE 2]] VOB');
  const value = materializePdfSourceRefs({ requirements: [{ ...req(4), source_refs: blocks.map(v => v.ref) }] }, blocks);
  assert.doesNotThrow(() => validatePdfExtraction(value, original, catalogue));
});
test('pure bid validity, submission method and signed offer LV are excluded without administrative output', () => {
  const clauses = [
    { title: 'Gültigkeit', description: 'Das Angebot gilt bis zum 30.11.2026.' },
    { title: 'Abgabe', description: 'Schriftlich oder per E-Mail bis 16.10.' },
    { title: 'Leistungsverzeichnis', description: 'Rechtsgültig unterschriebenes Leistungsverzeichnis einreichen.' },
  ];
  const original = '[[SOURCE formal.pdf PAGE 1]]\n' + clauses.map(v => v.description).join('\n');
  const requirements = clauses.map(item => ({ ...req(0), ...item, source_fragments: ['[[SOURCE formal.pdf PAGE 1]] ' + item.description] }));
  assert.deepEqual(validatePdfExtraction({ requirements }, original, catalogue), { requirements: [], output_limit_reached: false });
  assert.throws(() => validatePdfExtraction({ requirements: [], deadlines: [], documents: [] }, original, catalogue), /PDF_EXTRACTION_INVALID/);
});
test('the first two physical pages are isolated from subsequent LV pages', () => {
  const original = [1, 2, 3, 4].map(page => `[[SOURCE tender.pdf PAGE ${page}]]\nOriginal contents of page ${page}.` + ' x'.repeat(page > 2 ? 200 : 0)).join('\n');
  assert.equal(pdfRequirementChunks(original, 100_000).length, 1);
  const chunks = pdfRequirementChunks(original, 1000);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0], /PAGE 1/); assert.match(chunks[0], /PAGE 2/); assert.doesNotMatch(chunks[0], /PAGE 3/);
  assert.match(chunks[1], /PAGE 3/); assert.match(chunks[1], /PAGE 4/);
});
test('expired cache runtime prevents reads, extraction and creates; extraction overrun prevents publish', async () => {
  let reads = 0, extracts = 0, writes = 0;
  const cache: PdfExtractionCache = { async read() { reads++; return null; }, async create() { writes++; return 'created'; } };
  await assert.rejects(cachedPdfExtraction(cache, 'key', source, catalogue, async () => { extracts++; return raw(); }, { deadline: Date.now() - 1 }), WorkflowDeadlineError);
  assert.deepEqual([reads, extracts, writes], [0, 0, 0]);
  await assert.rejects(cachedPdfExtraction(cache, 'key', source, catalogue, async () => { extracts++; await new Promise(resolve => setTimeout(resolve, 20)); return raw(); }, { deadline: Date.now() + 5 }), WorkflowDeadlineError);
  assert.deepEqual([reads, extracts, writes], [1, 1, 0]);
});
test('stalled cache operations abort within independent timeout and preserve workflow deadline errors', async () => {
  let aborted = false;
  const stalled = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
  await assert.rejects(boundedPdfCacheOperation(stalled, undefined, 5), /PDF_EXTRACTION_CACHE_TIMEOUT/);
  assert.equal(aborted, true); aborted = false;
  await assert.rejects(boundedPdfCacheOperation(stalled, { deadline: Date.now() + 5 }), WorkflowDeadlineError);
  assert.equal(aborted, true);
});
test('dedicated Storage fetch receives abort for read and publish without a background continuation', async () => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL, previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://cache-test.invalid'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-not-a-credential';
  try {
    let calls = 0, aborted = 0;
    const cache = createPdfExtractionCache(async (_input, init) => {
      calls++;
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => { aborted++; reject(init!.signal!.reason); }, { once: true }));
    });
    await assert.rejects(boundedPdfCacheOperation(signal => cache.read('org/key.json', signal), undefined, 10), /CACHE_TIMEOUT/);
    await assert.rejects(boundedPdfCacheOperation(signal => cache.create('org/key.json', {}, signal), undefined, 10), /CACHE_TIMEOUT/);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 2); assert.equal(aborted, 2);
  } finally {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});
test('conflict winner reads also honor the workflow deadline', async () => {
  let reads = 0, aborted = false;
  const cache: PdfExtractionCache = {
    async read(_key, signal) {
      reads++; if (reads === 1) return null;
      return new Promise<never>((_, reject) => signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }, { once: true }));
    },
    async create() { return 'conflict'; },
  };
  await assert.rejects(cachedPdfExtraction(cache, 'key', source, catalogue, async () => raw(), { deadline: Date.now() + 15 }), WorkflowDeadlineError);
  assert.equal(reads, 2); assert.equal(aborted, true);
});

test('exclusion flag requires an explicit exclusion consequence or minimum eligibility standard in the cited source', () => {
  const clauses = [
    'Fehlt der Nachweis der Betriebshaftpflichtversicherung, wird das Angebot ausgeschlossen.',
    'Mindestanforderungen an die Eignung: Mindestumsatz 2 Mio. EUR.',
    'Der Probenehmer muss nach DepV die Fachkunde nachweisen können.',
    'Der Eignungsnachweis für das Asphaltmischgut ist zwingend vorzulegen.',
  ];
  const original = '[[SOURCE q.pdf PAGE 1]]\n' + clauses.join('\n');
  const requirements = clauses.map(description => ({ ...req(4), category: 'Personal', title: description.slice(0, 40), description, source_fragments: ['[[SOURCE q.pdf PAGE 1]] ' + description] }));
  const critical = new Map(validatePdfExtraction({ requirements }, original, catalogue).requirements.map(r => [r.description, r.is_critical]));
  assert.deepEqual(clauses.map(c => critical.get(c)), [true, true, false, false]);
  assert.equal(hasExclusionLanguage(['Nichtberücksichtigung des Angebots bei Fehlen']), true);
  assert.equal(hasExclusionLanguage(['Verbau nach DIN 4124']), false);
  for (const yes of ['Unvollständige Angebote werden ausgeschlossen.', 'Das Fehlen führt zum Ausschluß.', 'Fehlt der Nachweis, bleibt das Angebot unberücksichtigt.', 'Dies ist ein KO-Kriterium.', 'Ausschlusskriterium: Haftpflicht', 'Der Bieter wird vom Verfahren ausgeschlossen.', 'Mindestanforderungen an die Eignung', 'führt zum Aus-\nschluss des Angebots'])
    assert.equal(hasExclusionLanguage([yes]), true, yes);
  for (const no of ['Nebenangebote sind ausgeschlossen. Haftpflicht 3 Mio nachzuweisen.', 'Haftungsausschluss des AG', 'Ausschlussfristen für Mängelansprüche', 'Ausschluss von Recyclingmaterial', 'Das Labor muss Mindestanforderungen entsprechen.', 'Die Wurzelstockentfernung durch Sprengung ist ausgeschlossen.'])
    assert.equal(hasExclusionLanguage([no]), false, no);
  const notCritical = validatePdfExtraction({ requirements: [{ ...requirements[0], is_critical: false }] }, original, catalogue);
  assert.equal(notCritical.requirements[0].is_critical, false);
});
test('prompt scopes PDF requirements to bidder qualification and bumps the cache policy version', () => {
  assert.match(PDF_REQUIREMENTS_VERSION, /v11-gaeb-calibrated/);
  for (const scope of ['Präqualifikation', 'Referenzen', 'Versicherungsnachweise', 'Personal', 'leere Liste']) assert.ok(PDF_REQUIREMENTS_PROMPT.includes(scope), scope);
  assert.match(PDF_REQUIREMENTS_PROMPT, /NICHT AUFNEHMEN: technische Ausführungsvorgaben aus Leistungsverzeichnis/);
  assert.match(PDF_REQUIREMENTS_PROMPT, /Material-, Produkt- und Lieferantennachweise/);
  assert.doesNotMatch(PDF_REQUIREMENTS_PROMPT, /Leistungspflichten|Entsorgungsnachweise\./);
});

test('bidder declarations survive the form filter; statutory exclusion grounds keep the model flag (GAEB calibration)', () => {
  const clauses = [
    'Die Erklärung Bezug Russland (Formblatt 127) ist mit dem Angebot einzureichen.',
    'Erklärung zur Einhaltung von Mindestlohn und Tariftreue mit dem Angebot einreichen.',
    'Die Erklärung gegen ausbeuterische Kinderarbeit (Formblatt 2491) ist mit dem Angebot einzureichen.',
    'Nachunternehmererklärung (Formblatt 233) ist mit dem Angebot einzureichen.',
  ];
  const original = '[[SOURCE vhb.pdf PAGE 1]]\n' + clauses.join('\n');
  const titles = ['Erklärung Bezug Russland', 'Mindestlohn und Tariftreue', 'Erklärung Kinderarbeit', 'Nachunternehmererklärung'];
  const requirements = clauses.map((description, i) => ({ ...req(4), evidence_kind: 'form', title: titles[i], description, source_fragments: ['[[SOURCE vhb.pdf PAGE 1]] ' + description] }));
  const result = new Map(validatePdfExtraction({ requirements }, original, catalogue).requirements.map(r => [r.description, r.is_critical]));
  assert.deepEqual(clauses.map(c => result.get(c)), [true, true, false, false]);
  assert.equal(isStatutoryExclusionGround({ ...note(0), title: 'Verbau', description: 'Verbau nach DIN 4124' }), false);
});

test('cross-chunk items citing the same form merge with all evidence; statutory check uses the title only', () => {
  const a = { ...req(4), evidence_kind: 'form', title: 'Erklärung Bezug Russland', description: 'Erklärung (Formblatt 127) einreichen.', source_fragments: ['[[SOURCE vhb.pdf PAGE 1]] A'] };
  const b = { ...a, title: 'Russland-Sanktionen', description: 'Gemäß Formblatt 127 mit dem Angebot.', is_critical: false, source_fragments: ['[[SOURCE vhb.pdf PAGE 9]] B'] };
  const c = { ...a, title: 'Holz', description: 'Formblatt 248 einreichen.', source_fragments: ['[[SOURCE vhb.pdf PAGE 9]] C'] };
  const merged = mergePdfExtractions([{ requirements: [a] as any, output_limit_reached: false }, { requirements: [b, c] as any, output_limit_reached: false }]);
  assert.equal(merged.requirements.length, 2);
  const russia = merged.requirements.find(r => r.description.includes('127'))!;
  assert.deepEqual(russia.source_fragments, ['[[SOURCE vhb.pdf PAGE 1]] A', '[[SOURCE vhb.pdf PAGE 9]] B']);
  assert.equal(russia.is_critical, true);
  assert.equal(mergePdfExtractions([{ requirements: [a, b] as any, output_limit_reached: false }]).requirements.length, 2);
  // Umbrella form 124: different requirements citing the same form never merge.
  const ref = { ...a, title: 'Referenznachweise', description: 'Gemäß Formblatt 124.', source_fragments: ['[[SOURCE vhb.pdf PAGE 2]] R'] };
  const reg = { ...a, title: 'Gewerbeanmeldung', description: 'Gemäß Formblatt 124.', source_fragments: ['[[SOURCE vhb.pdf PAGE 9]] G'] };
  assert.equal(mergePdfExtractions([{ requirements: [ref] as any, output_limit_reached: false }, { requirements: [reg] as any, output_limit_reached: false }]).requirements.length, 2);
  // A critical duplicate is kept as the representative.
  const kept = mergePdfExtractions([{ requirements: [{ ...b, source_fragments: ['[[SOURCE vhb.pdf PAGE 1]] B'] }] as any, output_limit_reached: false }, { requirements: [{ ...a, source_fragments: ['[[SOURCE vhb.pdf PAGE 9]] A'] }] as any, output_limit_reached: false }]).requirements;
  assert.equal(kept.length, 1); assert.equal(kept[0].title, 'Erklärung Bezug Russland'); assert.equal(kept[0].is_critical, true);
  assert.equal(isStatutoryExclusionGround({ ...note(0), title: 'Referenznachweise', description: 'Angaben gemäß Formblatt Eigenerklärung zur Eignung' }), false);
  assert.equal(isStatutoryExclusionGround({ ...note(0), title: 'Eignungsnachweis ueber Praequalifikation', description: '' }), true);
});
