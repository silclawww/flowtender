import type { NodeExecutor, ExecutionItem, ExecutionContext } from '@/types/execution';
import { WorkflowDeadlineError } from '../retry-errors.ts';
import { runInWorker } from './worker-runtime.ts';

// Keep the worker-only PDF runtime in the serverless output trace.
async function tracePdfRuntime() {
  await import('@napi-rs/canvas');
  await import('pdf-parse');
  await import('pdf-parse/worker');
}
void tracePdfRuntime;

const workerSource = `
  const { parentPort, workerData } = require('node:worker_threads');
  (async () => {
    const allowedModules = new Map([
      ['crypto', require('node:crypto')],
      ['util', require('node:util')],
      ['path', require('node:path')],
      ['zlib', require('node:zlib')],
    ]);
    const safeRequire = (name) => {
      if (name === 'pdf-parse') {
        require('@napi-rs/canvas');
        const pdfParse = require('pdf-parse');
        pdfParse.PDFParse.setWorker(require('pdf-parse/worker').getPath());
        return pdfParse;
      }
      const module = allowedModules.get(name);
      if (!module) throw new Error("require('" + name + "') not allowed in code nodes");
      return module;
    };
    const workerConsole = Object.fromEntries(['log', 'warn', 'error'].map(method => [
      method,
      (...args) => parentPort.postMessage({ console: method, args }),
    ]));
    const input = workerData.input;
    const nodeContext = new Map(workerData.context);
    const $input = {
      first: () => input[0] || { json: {} },
      all: () => input,
      item: input[0] || { json: {} },
    };
    const $json = $input.first().json;
    const $nodeRef = nodeId => ({
      first: () => nodeContext.get(nodeId)?.[0] || { json: {} },
      all: () => nodeContext.get(nodeId) || [],
    });
    const deadlineSignal = Number.isFinite(workerData.deadline)
      ? AbortSignal.timeout(Math.max(1, workerData.deadline - Date.now()))
      : undefined;
    const deadlineFetch = (resource, init) => {
      const signals = [init?.signal, deadlineSignal].filter(Boolean);
      return fetch(resource, {
        ...init,
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      });
    };
    const execute = new Function(
      '$input', '$json', '$', 'require', 'JSON', 'fetch', 'console',
      'return (async () => { ' + workerData.code + '\\n})()',
    );
    const result = await execute(
      $input, $json, $nodeRef, safeRequire, JSON, deadlineFetch, workerConsole,
    );
    parentPort.postMessage({ result });
  })().catch(error => {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  });
`;

export const codeExecutor: NodeExecutor = {
  async execute(config, input, context, runtime) {
    const code = config.code as string;
    if (!code) return [[...input]]; // passthrough if no code

    const $json = input[0]?.json ?? {};

    try {
      const result = await runInWorker<unknown>(
        workerSource,
        {
          code,
          input,
          context: [...context.entries()],
          deadline: runtime?.deadline ?? Number.POSITIVE_INFINITY,
        },
        runtime,
      );
      
      // Normalize result to ExecutionItem[][]
      if (!result) return [[{ json: $json }]];
      if (Array.isArray(result)) {
        // Already an array of items
        if (result.length > 0 && result[0] && typeof result[0] === 'object' && 'json' in result[0]) {
          return [result as ExecutionItem[]]; // [{ json: {...} }, ...]
        }
        // Raw array — wrap each
        return [result.map(r => ({ json: typeof r === 'object' ? r : { value: r } }))];
      }
      if (typeof result === 'object' && 'json' in result) {
        return [[result as ExecutionItem]]; // single item
      }
      return [[{ json: result as Record<string, unknown> }]];
    } catch (err) {
      if (err instanceof WorkflowDeadlineError) throw err;
      const error = err instanceof Error ? err.message : String(err);
      throw new Error(`Code node execution error: ${error}`);
    }
  }
};
