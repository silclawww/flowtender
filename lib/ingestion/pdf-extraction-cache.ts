import { createClient } from '@supabase/supabase-js';
import type { ExecutionRuntime } from '../../types/execution.ts';
import { NonRetryableError, WorkflowDeadlineError } from '../retry-errors.ts';
import { PDF_REQUIREMENTS_VERSION, validatePdfExtraction, type PdfExtraction } from './pdf-requirements.ts';

export interface PdfExtractionCache {
  read(key: string, signal?: AbortSignal): Promise<unknown | null>;
  create(key: string, value: unknown, signal?: AbortSignal): Promise<'created' | 'conflict'>;
}
export function createPdfExtractionCache(fetchImpl: typeof fetch = fetch): PdfExtractionCache {
  // Dedicated client: never replace the shared GAEB/Supabase client's fetch.
  const bucketFor = (signal?: AbortSignal) => createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      if (signal?.aborted) throw signal.reason;
      return fetchImpl(input, { ...init, ...(signal ? { signal } : {}) });
    } } },
  ).storage.from('pdf-extraction-cache');
  return {
    async read(key, signal) {
      const { data, error } = await bucketFor(signal).download(key);
      if (signal?.aborted) throw signal.reason;
      if (error) {
        const status = String((error as { statusCode?: unknown }).statusCode ?? '');
        if (status === '404' || (status === '400' && error.message === 'Object not found')) return null;
        throw new Error('PDF_EXTRACTION_CACHE_READ_FAILED');
      }
      if (!data || data.size > 1_048_576) throw new Error('PDF_EXTRACTION_CACHE_INVALID');
      try { return JSON.parse(await data.text()); } catch { throw new Error('PDF_EXTRACTION_CACHE_INVALID'); }
    },
    async create(key, value, signal) {
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > 1_048_576) throw new Error('PDF_EXTRACTION_CACHE_TOO_LARGE');
      const { error } = await bucketFor(signal).upload(key, body, { upsert: false, contentType: 'application/json' });
      if (signal?.aborted) throw signal.reason;
      if (!error) return 'created';
      const status = String((error as { statusCode?: unknown }).statusCode ?? '');
      if (status === '409') return 'conflict';
      throw new Error('PDF_EXTRACTION_CACHE_WRITE_FAILED');
    },
  };
}
export async function cachedPdfExtraction(
  cache: PdfExtractionCache, key: string, source: string, catalogue: unknown,
  extract: () => Promise<unknown>, runtime?: ExecutionRuntime,
): Promise<PdfExtraction> {
  const validateEnvelope = (raw: unknown) => {
    const entry = raw as { version?: unknown; key?: unknown; extraction?: unknown } | null;
    if (!entry || entry.version !== PDF_REQUIREMENTS_VERSION || entry.key !== key) throw new Error('PDF_EXTRACTION_CACHE_INVALID');
    if (typeof (entry.extraction as { output_limit_reached?: unknown })?.output_limit_reached !== 'boolean') throw new Error('PDF_EXTRACTION_CACHE_INVALID');
    return validatePdfExtraction(entry.extraction, source, catalogue);
  };
  const stored = await boundedPdfCacheOperation(signal => cache.read(key, signal), runtime);
  if (stored !== null) return validateEnvelope(stored);
  assertPdfCacheDeadline(runtime);
  const extracted = await extract();
  assertPdfCacheDeadline(runtime);
  const extraction = validatePdfExtraction(extracted, source, catalogue);
  const outcome = await boundedPdfCacheOperation(signal => cache.create(key, { version: PDF_REQUIREMENTS_VERSION, key, extraction }, signal), runtime);
  if (outcome === 'created') return extraction;
  // Atomic create chooses a single immutable result for concurrent first uploads.
  const winner = await boundedPdfCacheOperation(signal => cache.read(key, signal), runtime);
  if (winner === null) throw new Error('PDF_EXTRACTION_CACHE_WINNER_MISSING');
  return validateEnvelope(winner);
}

function assertPdfCacheDeadline(runtime?: ExecutionRuntime): void {
  if (runtime?.deadline !== undefined && Date.now() >= runtime.deadline) throw new WorkflowDeadlineError();
}
export async function boundedPdfCacheOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>, runtime?: ExecutionRuntime, timeoutMs = 15_000,
): Promise<T> {
  assertPdfCacheDeadline(runtime);
  const remaining = runtime?.deadline === undefined ? Infinity : runtime.deadline - Date.now();
  const wait = Math.min(timeoutMs, remaining);
  const workflowLimited = remaining <= timeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = workflowLimited ? new WorkflowDeadlineError() : new NonRetryableError('PDF_EXTRACTION_CACHE_TIMEOUT');
      controller.abort(error);
      reject(error);
    }, wait);
  });
  try {
    const result = await Promise.race([operation(controller.signal), timeout]);
    assertPdfCacheDeadline(runtime);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // No later SDK continuation may begin another fetch using this request scope.
    controller.abort();
  }
}
