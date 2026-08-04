import { Worker } from 'node:worker_threads';

import { WorkflowDeadlineError } from '../retry-errors.ts';
import type { ExecutionRuntime } from '@/types/execution';

export function runInWorker<T>(
  source: string,
  workerData: Record<string, unknown>,
  runtime?: ExecutionRuntime,
): Promise<T> {
  if (runtime?.signal?.aborted) return Promise.reject(new WorkflowDeadlineError());
  const remaining = (runtime?.deadline ?? Number.POSITIVE_INFINITY) - Date.now();
  if (remaining <= 0) return Promise.reject(new WorkflowDeadlineError());

  const worker = new Worker(source, {
    eval: true,
    execArgv: ['--no-warnings'],
    stderr: true,
    stdout: true,
    workerData,
  });
  worker.stderr?.resume();
  worker.stdout?.resume();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      runtime?.signal?.removeEventListener('abort', onDeadline);
      worker.removeAllListeners();
      void worker.terminate();
      callback();
    };
    const onDeadline = () => finish(() => reject(new WorkflowDeadlineError()));

    worker.on('message', (message: {
      result?: T;
      error?: string;
      console?: 'log' | 'warn' | 'error';
      args?: unknown[];
    }) => {
      if (message.console) {
        console[message.console](...(message.args ?? []));
      } else if (message.error) {
        finish(() => reject(new Error(message.error)));
      } else {
        finish(() => resolve(message.result as T));
      }
    });
    worker.once('error', error => finish(() => reject(error)));
    worker.once('exit', code => {
      if (code !== 0) finish(() => reject(new Error('Worker exited unexpectedly')));
    });
    runtime?.signal?.addEventListener('abort', onDeadline, { once: true });
    if (Number.isFinite(remaining)) {
      timer = setTimeout(onDeadline, Math.max(1, Math.min(remaining, 2_147_483_647)));
    }
  });
}
