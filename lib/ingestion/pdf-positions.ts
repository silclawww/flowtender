/** Conservative text-layout recognition, not a GAEB parser or an OCR substitute.
 * A matched layout is evidence of extracted rows, never proof of total LV coverage.
 */
export interface PdfPage { num: number; text: string; source_file?: string }
interface Position {
  id: string; short_text: string; long_text: string; quantity: number | null;
  unit: string | null; category_path: string[]; gaeb_phase: null;
  source_type: 'pdf'; source_file: string | null; source_page: number; quantity_page: number | null;
}
export function extractPdfPositions(pages: PdfPage[], recognizedDepths?: Set<number>, requireTerminalDot = false) {
  if (pages.length > 2000 || pages.reduce((n, p) => n + p.text.length, 0) > 1000000) throw new Error('PDF_TEXT_LIMIT_EXCEEDED');
  const blocks: { id: string; title: string; lines: {text: string; page: number}[]; page: number; source_file?: string }[] = [];
  let current: typeof blocks[number] | undefined;
  const quantities = /^\s*((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?)\s+([\p{L}\d²³/%.-]+)\s+\.{4,}/u;
  let orphanRows = 0;
  let previousSource: string | undefined;
  for (const page of pages) {
    if (page.source_file !== previousSource) current = undefined;
    previousSource = page.source_file;
    for (const line of page.text.split(/\r?\n/)) {
      // At least two OZ components; arbitrary hierarchy depth. TOC leaders are not rows.
      const heading = /^\s*(\d+(?:\.\d+)+)\.?\s+(.+?)\s*$/.exec(line);
      if (heading && !/\.{4,}/.test(heading[2]) && !/^\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}$/.test(heading[1]) && (!recognizedDepths || recognizedDepths.has(heading[1].split('.').length)) && (!requireTerminalDot || new RegExp('^\\s*' + heading[1].replace(/\./g, '\\.') + '\\.\\s').test(line))) {
        current = {id: heading[1], title: heading[2], lines: [], page: page.num, source_file:page.source_file};
        blocks.push(current);
        if (blocks.length > 10000) throw new Error('PDF_POSITION_LIMIT_EXCEEDED');
      } else if (current) current.lines.push({text: line, page: page.num});
      else if (quantities.test(line)) orphanRows++;
    }
  }
  if (!recognizedDepths) {
    const depths = new Set(blocks.filter(b => b.lines.some(l => quantities.test(l.text))).map(b => b.id.split('.').length));
    const numberedLines = pages.flatMap(p => p.text.split(/\r?\n/)).filter(l => { const m = /^\s*(\d+(?:\.\d+)+)\.?\s/.exec(l); return m && depths.has(m[1].split('.').length); });
    const dotted = numberedLines.filter(l => /^\s*\d+(?:\.\d+)+\.\s/.test(l)).length;
    if (depths.size) return extractPdfPositions(pages, depths, dotted >= 10 && dotted / numberedLines.length > 0.8);
  }
  // Headings with descendants are sections, not positions. Leaf headings with no
  // quantity remain unresolved candidates: silently discarding them hides loss.
  const parentIds = new Set<string>();
  for (const b of blocks) {
    const parts = b.id.split('.');
    for (let depth = 1; depth < parts.length; depth++) parentIds.add(JSON.stringify([b.source_file || null, parts.slice(0, depth).join('.')]));
  }
  const candidates = blocks.filter(b => !parentIds.has(JSON.stringify([b.source_file || null, b.id])));
  const counts = new Map<string, number>();
  for (const b of candidates) counts.set(b.id, (counts.get(b.id) || 0) + 1);
  let ambiguous = 0;
  let missing = 0;
  const positions: Position[] = candidates.map(b => {
    const rows = b.lines.flatMap(l => { const m = quantities.exec(l.text); return m ? [{m, page:l.page}] : []; });
    const valid = rows.length === 1 && counts.get(b.id) === 1;
    if (rows.length > 1 || counts.get(b.id)! > 1) ambiguous++;
    else if (!rows.length) missing++;
    return {
      id:b.id, short_text:b.title, long_text:b.lines.map(l => l.text).join('\n'),
      quantity:valid ? Number(rows[0].m[1].replace(/\./g, '').replace(',', '.')) : null,
      unit:valid ? rows[0].m[2] : null,
      category_path:[], gaeb_phase:null, source_type:'pdf', source_file:b.source_file || null, source_page:b.page,
      quantity_page:valid ? rows[0].page : null,
    };
  });
  return {positions, coverage: {
    source_type:'pdf' as const, method:'text_layout' as const, verified_complete:false,
    status: ambiguous ? 'ambiguous' : !positions.length ? 'unsupported' : missing || orphanRows ? 'incomplete' : 'pattern_matched',
    candidate_count:candidates.length, extracted_count:positions.filter(p => p.quantity !== null).length,
    unresolved_count:missing + ambiguous, orphan_quantity_rows:orphanRows,
    page_count:pages.length,
  }};
}

export function extractPdfSourceMetadata(pages: PdfPage[]) {
  const dated = (s:string) => {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
    if (!m) return null;
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    const date = new Date(iso+'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === iso ? iso : null;
  };
  const projectIds = new Set<string>();
  const execution: {start:string;end:string;note:string;page:number}[] = [];
  const binding = new Set<string>();
  for (const page of pages) {
    for (const line of page.text.split(/\r?\n/)) {
      const project = /(?:Angebots-\/\s*Baustellen-Nr\.|Projekt(?:nummer|\s*-?\s*Nr\.?)?)\s*:\s*(\d{6,})/i.exec(line);
      if (project) projectIds.add(project[1]);
      const range = /Ausführungszeitraum\s*:\s*(\d{2}\.\d{2}\.\d{4})\s*[-–]\s*(\d{2}\.\d{2}\.\d{4})(.*)/i.exec(line);
      if (range) { const start=dated(range[1]), end=dated(range[2]); if(start && end && start<=end) execution.push({start,end,note:range[3].trim(),page:page.num}); }
      const bind = /(?:Angebot\s+bis\s+zum|Angebot\s+gebunden\s+bis:?)\s*(\d{2}\.\d{2}\.\d{4})/i.exec(line);
      if(bind) {const date=dated(bind[1]);if(date) binding.add(date);}
    }
  }
  const ranges = new Set(execution.map(e => e.start+'|'+e.end));
  const one = ranges.size === 1 ? execution[0] : null;
  return {project_id:projectIds.size===1 ? [...projectIds][0] : null,
    conflicting_project_ids:projectIds.size>1 ? [...projectIds] : [],
    execution_start:one?.start || null, execution_end:one?.end || null,
    execution_evidence:execution, binding_until:binding.size===1 ? [...binding][0] : null};
}

/** Keep only verifiable page citations. Missing/loose paraphrases remain useful
 * candidates but must not masquerade as directly evidenced obligations. */
export function groundPdfRequirements(requirements: {source_fragments:string[];is_implicit:boolean;[key:string]:unknown}[], text:string) {
  const markers = [...text.matchAll(/\[\[SOURCE [^\]\r\n]+ PAGE \d+\]\]/g)];
  const sources = new Map<string,string>();
  const normalize = (value:string) => value.normalize('NFKC').replace(/-\s*\n\s*/g,'').replace(/\s+/g,' ').trim();
  markers.forEach((m,i)=>sources.set(m[0], normalize(text.slice(m.index!+m[0].length,markers[i+1]?.index ?? text.length))));
  let ungrounded = 0;
  const grounded = requirements.map(r => {
    const valid = r.source_fragments.filter(fragment => {
      const m = /^\s*(\[\[SOURCE [^\]\r\n]+ PAGE \d+\]\])\s*([\s\S]*)$/.exec(fragment);
      if(!m || !sources.has(m[1])) return false;
      const quote = normalize(m[2].replace(/^[:\s“”"'„]+|[\s“”"'„]+$/g,''));
      return quote.length >= 10 && sources.get(m[1])!.includes(quote);
    });
    if(valid.length !== r.source_fragments.length || !valid.length) ungrounded++;
    return {...r, source_fragments:valid, is_implicit: r.is_implicit};
  });
  return {requirements:grounded, ungrounded_count:ungrounded};
}
