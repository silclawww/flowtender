import { createServiceClient } from '../supabase/service.ts';
import { PDF_REQUIREMENTS_VERSION, validatePdfExtraction, type PdfExtraction } from './pdf-requirements.ts';

export interface PdfExtractionCache {
  read(key: string): Promise<unknown | null>;
  create(key: string, value: unknown): Promise<'created' | 'conflict'>;
}
export function createPdfExtractionCache(): PdfExtractionCache {
  const bucket = createServiceClient().storage.from('pdf-extraction-cache');
  return {
    async read(key) {
      const { data, error } = await bucket.download(key);
      if (error) {
        const status = String((error as { statusCode?: unknown }).statusCode ?? '');
        if (status === '404' || (status === '400' && error.message === 'Object not found')) return null;
        throw new Error('PDF_EXTRACTION_CACHE_READ_FAILED');
      }
      if (!data || data.size > 1_048_576) throw new Error('PDF_EXTRACTION_CACHE_INVALID');
      try { return JSON.parse(await data.text()); } catch { throw new Error('PDF_EXTRACTION_CACHE_INVALID'); }
    },
    async create(key, value) {
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > 1_048_576) throw new Error('PDF_EXTRACTION_CACHE_TOO_LARGE');
      const { error } = await bucket.upload(key, body, { upsert: false, contentType: 'application/json' });
      if (!error) return 'created';
      const status = String((error as { statusCode?: unknown }).statusCode ?? '');
      if (status === '409') return 'conflict';
      throw new Error('PDF_EXTRACTION_CACHE_WRITE_FAILED');
    },
  };
}
export async function cachedPdfExtraction(
  cache: PdfExtractionCache, key: string, source: string, catalogue: unknown,
  extract: () => Promise<unknown>,
): Promise<PdfExtraction> {
  const validateEnvelope = (raw: unknown) => {
    const entry = raw as { version?: unknown; key?: unknown; extraction?: unknown } | null;
    if (!entry || entry.version !== PDF_REQUIREMENTS_VERSION || entry.key !== key) throw new Error('PDF_EXTRACTION_CACHE_INVALID');
    if (typeof (entry.extraction as { output_limit_reached?: unknown })?.output_limit_reached !== 'boolean') throw new Error('PDF_EXTRACTION_CACHE_INVALID');
    return validatePdfExtraction(entry.extraction, source, catalogue);
  };
  const stored = await cache.read(key);
  if (stored !== null) return validateEnvelope(stored);
  const extraction = validatePdfExtraction(await extract(), source, catalogue);
  const outcome = await cache.create(key, { version: PDF_REQUIREMENTS_VERSION, key, extraction });
  if (outcome === 'created') return extraction;
  // Atomic create chooses a single immutable result for concurrent first uploads.
  const winner = await cache.read(key);
  if (winner === null) throw new Error('PDF_EXTRACTION_CACHE_WINNER_MISSING');
  return validateEnvelope(winner);
}
