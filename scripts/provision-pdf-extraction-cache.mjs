import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';

const BUCKET = 'pdf-extraction-cache';
const OPTIONS = { public: false, fileSizeLimit: 1_048_576, allowedMimeTypes: ['application/json'] };
const matches = bucket => bucket?.public === false
  && Number(bucket.file_size_limit) === OPTIONS.fileSizeLimit
  && Array.isArray(bucket.allowed_mime_types)
  && bucket.allowed_mime_types.length === 1
  && bucket.allowed_mime_types[0] === 'application/json';

// Bucket metadata only: never reads, changes or deletes cached objects/tenders.
export async function provisionPdfExtractionCache(client) {
  const listed = await client.storage.listBuckets();
  if (listed.error || !Array.isArray(listed.data)) throw new Error('Bucket lookup failed');
  const existing = listed.data.find(bucket => bucket.id === BUCKET);
  if (!existing || !matches(existing)) {
    const result = existing
      ? await client.storage.updateBucket(BUCKET, OPTIONS)
      : await client.storage.createBucket(BUCKET, OPTIONS);
    if (result.error) throw new Error('Bucket provisioning failed');
  }
  // Verify the server response even when the bucket already existed.
  const verified = await client.storage.getBucket(BUCKET);
  if (verified.error || !matches(verified.data)) throw new Error('Bucket configuration verification failed');
  return { bucket: BUCKET, public: false, file_size_limit: OPTIONS.fileSizeLimit, allowed_mime_types: OPTIONS.allowedMimeTypes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Required server environment unavailable');
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    console.log(JSON.stringify(await provisionPdfExtractionCache(client)));
  } catch {
    // Provider errors can include request details. Emit no credentials or raw response.
    console.error('PDF cache provisioning failed; check server credentials and Storage configuration.');
    process.exitCode = 1;
  }
}
