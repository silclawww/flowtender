import type { NodeExecutor } from '../../types/execution.ts';
import { httpRequestExecutor } from './http-request.ts';
import { cachedPdfExtraction, createPdfExtractionCache, type PdfExtractionCache } from '../ingestion/pdf-extraction-cache.ts';
import { extractPdfChunks, pdfExtractionKey, PDF_REQUIREMENTS_MODEL, PDF_REQUIREMENTS_PROMPT, PDF_REQUIREMENTS_SCHEMA } from '../ingestion/pdf-requirements.ts';
import { NonRetryableError, WorkflowDeadlineError } from '../retry-errors.ts';

export function createPdfRequirementsExecutor(
  cacheFactory: () => PdfExtractionCache = createPdfExtractionCache,
  http: NodeExecutor = httpRequestExecutor,
): NodeExecutor {
  return {
    async execute(config, input, context, runtime) {
      const tender = context.get('load-tender')?.[0]?.json;
      if (tender?.source_type !== 'pdf') return http.execute(config, input, context, runtime);
      const prepared = context.get('prepare-extraction-text')?.[0]?.json ?? {};
      const coverage = prepared.requirements_coverage as { source_insufficient?: boolean } | undefined;
      if (coverage?.source_insufficient) throw new NonRetryableError('PDF_EXTRACTION_SOURCE_INSUFFICIENT');
      const source = [prepared.selected_checkbox_state, prepared.extraction_text].filter(v => typeof v === 'string' && v).join('\n\n');
      if (source.length < 50 || source.length > 1_000_002) throw new NonRetryableError('PDF_EXTRACTION_SOURCE_INVALID');
      const orgId = String(context.get('trigger')?.[0]?.json.org_id ?? '');
      if (tender.org_id !== orgId) throw new NonRetryableError('INVALID_TENANT_CONTEXT');
      const catalogue = prepared.certificate_catalogue ?? { version: null, entries: [] };
      const key = pdfExtractionKey(orgId, source, catalogue);
      try {
        const extraction = await cachedPdfExtraction(cacheFactory(), key, source, catalogue, async () => extractPdfChunks(source, catalogue, async (chunk) => {
          const body = {
            model: PDF_REQUIREMENTS_MODEL, temperature: 0,
            messages: [{ role: 'system', content: PDF_REQUIREMENTS_PROMPT }, { role: 'user', content: 'ZERTIFIKATSKATALOG:\n' + JSON.stringify(catalogue) + '\n\nQUELLEN:\n' + chunk }],
            response_format: { type: 'json_schema', json_schema: { name: 'pdf_source_extraction', strict: true, schema: PDF_REQUIREMENTS_SCHEMA } },
            extra_body: { google: { thinking_config: { thinking_budget: 8192 } } },
          };
          const output = await http.execute({ ...config, body: undefined, body_input_field: 'pdf_extraction_request' }, [{ json: { pdf_extraction_request: body } }], context, runtime);
          const response = output[0]?.[0]?.json as { choices?: { message?: { content?: unknown } }[] } | undefined;
          const content = response?.choices?.[0]?.message?.content;
          if (typeof content !== 'string') throw new Error('PDF_EXTRACTION_INVALID');
          try { return JSON.parse(content); } catch { throw new Error('PDF_EXTRACTION_INVALID'); }
        }), runtime);
        return [[{ json: { pdf_extraction: extraction } }]];
      } catch (error) {
        if (error instanceof WorkflowDeadlineError) throw error;
        // Never regenerate silently when persistence or cached validation fails.
        const message = error instanceof Error && /^PDF_EXTRACTION_[A-Z_]+$/.test(error.message) ? error.message : 'PDF_EXTRACTION_FAILED';
        throw new NonRetryableError(message);
      }
    },
  };
}
export const pdfRequirementsExecutor = createPdfRequirementsExecutor();
