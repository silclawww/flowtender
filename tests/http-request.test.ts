import assert from 'node:assert/strict';
import test from 'node:test';

import { httpRequestExecutor } from '../lib/nodes/http-request.ts';

const config = {
  method: 'POST',
  url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  body: '{{ JSON.stringify($json) }}',
  timeout_ms: 25,
};

async function withFetch(
  replacement: typeof fetch,
  operation: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    await operation();
  } finally {
    globalThis.fetch = original;
  }
}

test('Gemini 429 exhausts its bounded retries and fails the node', async () => {
  let calls = 0;
  const messages: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => messages.push(String(message));
  await withFetch(async () => {
    calls += 1;
    return new Response('', { status: 429, headers: { 'retry-after': '0' } });
  }, async () => {
    try {
      await assert.rejects(
        () => httpRequestExecutor.execute(config, [{ json: { prompt: 'synthetic' } }], new Map()),
        /HTTP 429/,
      );
    } finally {
      console.log = originalLog;
    }
  });
  assert.equal(calls, 4);
  assert.equal(messages.length, 3);
  assert.doesNotMatch(messages.join('\n'), /retry 4\/3/);
});

test('Gemini 5xx fails without returning a successful node result', async () => {
  await withFetch(async () => new Response('provider unavailable', { status: 503 }), async () => {
    await assert.rejects(
      () => httpRequestExecutor.execute(config, [{ json: { prompt: 'synthetic' } }], new Map()),
      /HTTP 503/,
    );
  });
});

test('Gemini timeout aborts the request and fails the node', async () => {
  await withFetch((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  }), async () => {
    await assert.rejects(
      () => httpRequestExecutor.execute(
        { ...config, timeout_ms: 1 },
        [{ json: { prompt: 'synthetic' } }],
        new Map(),
      ),
      /timed out after 1ms/,
    );
  });
});
