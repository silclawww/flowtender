#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tracePath = fileURLToPath(new URL(
  '../.next/server/app/api/flow/webhook/[path]/route.js.nft.json',
  import.meta.url,
));
const trace = JSON.parse(await readFile(tracePath, 'utf8'));
const files = Array.isArray(trace.files) ? trace.files : [];
const hasPdfParse = files.some((file) => file.includes('/node_modules/pdf-parse/'));
const hasPdfJs = files.some((file) => file.includes('/node_modules/pdfjs-dist/'));
const hasCanvas = files.some((file) => file.includes('/node_modules/@napi-rs/canvas/'));
const hasNativeCanvas = files.some((file) => (
  /\/node_modules\/@napi-rs\/canvas(?:-[^/]+)?\/.*\.node$/.test(file)
));

if (!hasPdfParse || !hasPdfJs || !hasCanvas || !hasNativeCanvas) {
  throw new Error('Webhook bundle is missing the Stage 1 PDF runtime');
}

for (const file of files.filter((candidate) => candidate.endsWith('.js'))) {
  const source = await readFile(resolve(dirname(tracePath), file), 'utf8');
  if (source.includes('Cannot find module as expression is too dynamic')) {
    throw new Error('Webhook bundle contains an unresolved dynamic module loader');
  }
}

await createRequire(import.meta.url)(tracePath.replace(/\.nft\.json$/, ''));
process.stdout.write('Webhook bundle includes the Stage 1 PDF runtime\n');
