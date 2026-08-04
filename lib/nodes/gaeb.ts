import type { NodeExecutor, ExecutionItem, ExecutionContext } from '@/types/execution';
import * as path from 'path';
import { Worker } from 'node:worker_threads';
import { WorkflowDeadlineError } from '../retry-errors.ts';
import type { ExecutionRuntime } from '@/types/execution';

// Returns the path to Tenderly GAEB parser at runtime (not build time)
// This must be a function to avoid Turbopack static analysis
function getGaebParserPath(): string {
  return path.join(process.cwd(), '../tenderly-agent/lib/gaeb-parser-n8n.js');
}

export interface GaebParseConfig {
  file_data_field?: string;  // field name containing base64 file data (default: 'file_data')
  file_name_field?: string;  // field name containing the filename (default: 'file_name')
}

interface GaebResult {
  gaeb_files: unknown[];
  documents: unknown[];
  has_plans: boolean;
  archive_summary: Record<string, unknown>;
}

const workerSource = `
  const { parentPort, workerData } = require('node:worker_threads');
  try {
    const { parseGaebFile } = require(workerData.parserPath);
    const result = parseGaebFile(Buffer.from(workerData.fileData, 'base64'), workerData.fileName);
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
`;

function parseGaebInWorker(
  parserPath: string,
  fileData: string,
  fileName: string,
  runtime?: ExecutionRuntime,
): Promise<GaebResult> {
  if (runtime?.signal?.aborted) return Promise.reject(new WorkflowDeadlineError());
  const remaining = (runtime?.deadline ?? Number.POSITIVE_INFINITY) - Date.now();
  if (remaining <= 0) return Promise.reject(new WorkflowDeadlineError());

  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { parserPath, fileData, fileName },
  });

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      runtime?.signal?.removeEventListener('abort', onDeadline);
      void worker.terminate();
      callback();
    };
    const onDeadline = () => finish(() => reject(new WorkflowDeadlineError()));

    worker.once('message', (message: { result?: GaebResult; error?: string }) => {
      if (message.error) finish(() => reject(new Error(message.error)));
      else finish(() => resolve(message.result!));
    });
    worker.once('error', error => finish(() => reject(error)));
    worker.once('exit', code => {
      if (code !== 0) finish(() => reject(new Error('GAEB parser worker exited unexpectedly')));
    });
    runtime?.signal?.addEventListener('abort', onDeadline, { once: true });
    if (Number.isFinite(remaining)) timer = setTimeout(onDeadline, Math.max(1, remaining));
  });
}

export const gaebParseExecutor: NodeExecutor = {
  async execute(config, input, _context, runtime) {
    const dataField = (config.file_data_field as string) || 'file_data';
    const nameField = (config.file_name_field as string) || 'file_name';
    
    const item = input[0]?.json || {};
    const fileData = item[dataField] as string;
    const fileName = (item[nameField] as string) || 'upload.avasign';
    
    if (!fileData) {
      throw new Error(`gaeb_parse: no file data found at field '${dataField}'`);
    }
    
    const parserPath = getGaebParserPath();
    const result = await parseGaebInWorker(parserPath, fileData, fileName, runtime);
    
    return [[{
      json: {
        ...item,
        gaeb_files: result.gaeb_files,
        documents: result.documents,
        has_plans: result.has_plans,
        archive_summary: result.archive_summary,
        file_data: undefined, // Remove base64 to save memory
      }
    }]];
  }
};
