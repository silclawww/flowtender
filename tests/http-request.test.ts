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

async function withImmediateRetryTimers(
  operation: () => Promise<void>,
): Promise<void> {
  const originalSetTimeout = globalThis.setTimeout;
  let timerCalls = 0;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    timerCalls += 1;
    // Each 429 attempt registers its abort timer first and retry delay second.
    if (timerCalls % 2 === 0) queueMicrotask(callback);
    return timerCalls as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    await operation();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

test('HTTP requests process a bounded item batch sequentially with per-item templates', async () => {
  const requestBodies: string[] = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;

  await withFetch(async (_url, init) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    const body = String(init?.body);
    requestBodies.push(body);
    await Promise.resolve();
    activeRequests -= 1;
    return Response.json({ echoed: JSON.parse(body) });
  }, async () => {
    const output = await httpRequestExecutor.execute(
      { ...config, process_each_item: true, timeout_ms: 1_000 },
      [
        { json: { chunk: 1 } },
        { json: { chunk: 2 } },
        { json: { chunk: 3 } },
      ],
      new Map(),
    );

    assert.deepEqual(requestBodies, [
      '{"chunk":1}',
      '{"chunk":2}',
      '{"chunk":3}',
    ]);
    assert.deepEqual(output[0].map(item => item.json), [
      { echoed: { chunk: 1 } },
      { echoed: { chunk: 2 } },
      { echoed: { chunk: 3 } },
    ]);
    assert.equal(maxActiveRequests, 1);
  });
});

test('HTTP requests reject oversized item batches before contacting the provider', async () => {
  let calls = 0;

  await withFetch(async () => {
    calls += 1;
    return Response.json({ ok: true });
  }, async () => {
    await assert.rejects(
      () => httpRequestExecutor.execute(
        { ...config, process_each_item: true, timeout_ms: 1_000 },
        Array.from({ length: 11 }, (_, index) => ({ json: { chunk: index + 1 } })),
        new Map(),
      ),
      /HTTP item batch too large/,
    );
  });

  assert.equal(calls, 0);
});

test('HTTP requests serialize a bounded body object from each input item', async () => {
  const requestBodies: string[] = [];

  await withFetch(async (_url, init) => {
    requestBodies.push(String(init?.body));
    return Response.json({ ok: true });
  }, async () => {
    await httpRequestExecutor.execute(
      {
        ...config,
        body_input_field: 'request_body',
        process_each_item: true,
        timeout_ms: 1_000,
      },
      [
        { json: { request_body: { chunk: 1 } } },
        { json: { request_body: { chunk: 2 } } },
      ],
      new Map(),
    );
  });

  assert.deepEqual(requestBodies, ['{"chunk":1}', '{"chunk":2}']);
});

test('HTTP requests retain first-item-only behavior unless batching is explicit', async () => {
  const requestBodies: string[] = [];

  await withFetch(async (_url, init) => {
    requestBodies.push(String(init?.body));
    return Response.json({ ok: true });
  }, async () => {
    const output = await httpRequestExecutor.execute(
      { ...config, timeout_ms: 1_000 },
      [{ json: { chunk: 1 } }, { json: { chunk: 2 } }],
      new Map(),
    );

    assert.equal(output[0].length, 1);
  });

  assert.deepEqual(requestBodies, ['{"chunk":1}']);
});

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
        () => httpRequestExecutor.execute(
          { ...config, timeout_ms: 1_000 },
          [{ json: { prompt: 'synthetic' } }],
          new Map(),
        ),
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

test('Gemini cancels every bounded 429 response body before retry or failure', async () => {
  let calls = 0;
  let cancellations = 0;
  const originalLog = console.log;
  console.log = () => {};
  try {
    await withImmediateRetryTimers(async () => {
      await withFetch(async () => {
        calls += 1;
        return new Response(new ReadableStream({
          cancel() { cancellations += 1; },
        }), { status: 429, headers: { 'retry-after': '0' } });
      }, async () => {
        await assert.rejects(
          () => httpRequestExecutor.execute(config, [{ json: { prompt: 'synthetic' } }], new Map()),
          /HTTP 429/,
        );
      });
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(calls, 4);
  assert.equal(cancellations, 4);
});

test('Gemini fails with a fixed error when a 429 response body cannot be canceled', async () => {
  await withFetch(async () => new Response(new ReadableStream({
    cancel() { throw new Error('raw provider cleanup detail'); },
  }), { status: 429, headers: { 'retry-after': '0' } }), async () => {
    await assert.rejects(
      () => httpRequestExecutor.execute(config, [{ json: { prompt: 'synthetic' } }], new Map()),
      (error: unknown) => {
        assert.equal((error as Error).message, 'HTTP response cleanup failed');
        assert.doesNotMatch(String(error), /raw provider cleanup detail/);
        return true;
      },
    );
  });
});

test('Gemini accepts only strict RFC delay-seconds Retry-After values', async () => {
  const cases = [
    { header: '0', waitMs: 0 },
    { header: ' 2 ', waitMs: 2_000 },
    { header: '0003', waitMs: 3_000 },
    { header: '', waitMs: 5_000 },
    { header: '   ', waitMs: 5_000 },
    { header: '-1', waitMs: 5_000 },
    { header: '0x0', waitMs: 5_000 },
    { header: '1e0', waitMs: 5_000 },
    { header: '0.5', waitMs: 5_000 },
    { header: 'malformed', waitMs: 5_000 },
  ];

  for (const { header, waitMs } of cases) {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => messages.push(String(message));
    try {
      await withImmediateRetryTimers(async () => {
        await withFetch(
          async () => new Response('', { status: 429, headers: { 'retry-after': header } }),
          async () => {
            await assert.rejects(
              () => httpRequestExecutor.execute(
                { ...config, timeout_ms: 10_000 },
                [{ json: { prompt: 'synthetic' } }],
                new Map(),
              ),
              /HTTP 429/,
            );
          },
        );
      });
    } finally {
      console.log = originalLog;
    }
    assert.equal(messages.length, 3);
    for (const message of messages) assert.match(message, new RegExp(`waiting ${waitMs}ms`));
  }
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

for (const contentType of ['application/json', 'text/plain']) {
  test(`Gemini timeout covers a stalled ${contentType} response body`, async () => {
    await withFetch(async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': contentType }),
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }),
      text: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }),
    } as Response), async () => {
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
}

test('Gemini clamps Retry-After to the request attempt budget', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return new Response('', { status: 429, headers: { 'retry-after': '86400' } });
  }, async () => {
    await assert.rejects(
      () => httpRequestExecutor.execute(
        { ...config, timeout_ms: 1 },
        [{ json: { prompt: 'synthetic' } }],
        new Map(),
      ),
      /timed out after 1ms/,
    );
  });
  assert.equal(calls, 1);
});
