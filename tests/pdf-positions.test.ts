import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPdfPositions } from '../lib/ingestion/pdf-positions.ts';

test('dotted identifiers, decimal commas, zero and page continuations retain evidence', () => {
  const r = extractPdfPositions([{num: 1, text: '1. Bereich\n1.10. Boden lösen\nLangtext'}, {num: 2, text: 'Fortsetzung\n1.265,000 m3 ........ ........\n1.20. Prüfung\n0,000 St ........ ........'}]);
  assert.equal(r.positions.length, 2);
  assert.equal(r.positions[0].quantity, 1265);
  assert.equal(r.positions[0].source_page, 1);
  assert.equal(r.positions[0].quantity_page, 2);
  assert.match(r.positions[0].long_text, /Fortsetzung/);
  assert.equal(r.positions[1].quantity, 0);
  assert.equal(r.coverage.status, 'pattern_matched');
});
test('unknown quantities, duplicates, unmatched rows never become confident quantities', () => {
  const r = extractPdfPositions([{num: 1,text:'1.10. Arbeit\nnach Aufwand St ........\n1.20. Arbeit\n2,000 m ........\n3,000 m ........\n1.20. Duplicate\n4,000 m ........'}]);
  assert.equal(r.coverage.status, 'ambiguous');
  assert.ok(r.positions.every(p => p.quantity === null));
});
test('scanned/no positions and table of contents are unsupported, not zero workload', () => {
  assert.equal(extractPdfPositions([]).coverage.status, 'unsupported');
  assert.equal(extractPdfPositions([{num:1,text:'1.10. Erdarbeiten...........................12'}]).positions.length, 0);
});

test('position depth/style inferred without confusing inline standards with headings', () => {
  const text = Array.from({length:12}, (_,i)=>`1.1.${i+1}. Item\n2,000 m ........`).join('\n') + '\n1.1.13. Crosspage\n';
  const result = extractPdfPositions([{num:1,text}, {num:2,text:'6.1.3 DWA-A rule continuation\n3,000 St ........'}]);
  assert.equal(result.positions.length, 13);
  assert.equal(result.positions[12].quantity,3);
  assert.match(result.positions[12].long_text,/DWA-A/);
});

test('oversized input fails explicitly, never silently truncates', () => {
  assert.throws(() => extractPdfPositions([{num:1,text:'x'.repeat(1000001)}]), /PDF_TEXT_LIMIT_EXCEEDED/);
});

test('PDF citations must quote the named page, not invented filenames or other pages', async () => {
  const {groundPdfRequirements} = await import('../lib/ingestion/pdf-positions.ts');
  const text='[[SOURCE actual.pdf PAGE 1]]\nFestpreise für die gesamte Bauzeit.\n[[SOURCE actual.pdf PAGE 2]]\nEine andere Verpflichtung.';
  const r=groundPdfRequirements([
    {is_implicit:false,source_fragments:['[[SOURCE actual.pdf PAGE 1]] Festpreise für die gesamte Bauzeit.']},
    {is_implicit:false,source_fragments:['[[SOURCE invented.pdf PAGE 1]] Festpreise für die gesamte Bauzeit.']},
    {is_implicit:false,source_fragments:['[[SOURCE actual.pdf PAGE 2]] Festpreise für die gesamte Bauzeit.']},
  ],text);
  assert.equal(r.ungrounded_count,2);
  assert.equal(r.requirements[0].is_implicit,false);
  assert.deepEqual(r.requirements[1].source_fragments,[]);
  assert.equal(r.requirements[2].is_implicit,false);
});

test('metadata preserves subsidiary date ambiguity and rejects invalid or conflicting dates', async () => {
  const {extractPdfSourceMetadata} = await import('../lib/ingestion/pdf-positions.ts');
  const r=extractPdfSourceMetadata([{num:1,text:'Projekt: 123456\nAusführungszeitraum: 08.03.2027 - 17.09.2027 (Sub: 20.10.26)\nSie sind an Ihr Angebot bis zum 30.11.2026 gebunden.'}]);
  assert.equal(r.execution_start,'2027-03-08');
  assert.equal(r.binding_until,'2026-11-30');
  assert.equal(r.execution_evidence[0].note,'(Sub: 20.10.26)');
  const invalid=extractPdfSourceMetadata([{num:1,text:'Ausführungszeitraum: 31.02.2027 - 17.09.2027'}]);
  assert.equal(invalid.execution_start,null);
  const conflict=extractPdfSourceMetadata([{num:1,text:'Projekt: 123456\nProjekt: 654321'}]);
  assert.equal(conflict.project_id,null);
  assert.equal(conflict.conflicting_project_ids.length,2);
});

test('a new source file cannot supply the previous file’s missing quantity', () => {
  const r=extractPdfPositions([
    {num:1,source_file:'lv-a.pdf',text:'1.10. Unresolved earthworks'},
    {num:1,source_file:'lv-b.pdf',text:'999,000 m3 ........'},
  ]);
  assert.equal(r.positions[0].quantity,null);
  assert.equal(r.positions[0].source_file,'lv-a.pdf');
  assert.equal(r.coverage.orphan_quantity_rows,1);
  assert.equal(r.coverage.status,'incomplete');
});

test('hierarchy inference never drops another file’s leaf; duplicate IDs stay ambiguous', () => {
  const r=extractPdfPositions([
    {num:1,source_file:'a.pdf',text:'1.10. A\n1,000 m ........'},
    {num:1,source_file:'b.pdf',text:'1.10.10. B\n2,000 m ........'},
  ]);
  assert.equal(r.positions.length,2);
  const duplicate=extractPdfPositions([
    {num:1,source_file:'a.pdf',text:'1.10. A\n1,000 m ........'},
    {num:1,source_file:'b.pdf',text:'1.10. B\n2,000 m ........'},
  ]);
  assert.equal(duplicate.coverage.status,'ambiguous');
  assert.ok(duplicate.positions.every(p=>p.quantity===null));
});

test('unrepresentable quantities stay unresolved rather than overflowing or rounding', () => {
  for (const quantity of ['9'.repeat(400)+',000','9007199254740993,000','1234567890123,123','0,12345678901234567']) {
    const r=extractPdfPositions([{num:1,text:`1.10. Work\n${quantity} m3 ........`}]);
    assert.equal(r.positions[0].quantity,null);
    assert.equal(r.coverage.extracted_count,0);
    assert.equal(r.coverage.status,'incomplete');
  }
});
