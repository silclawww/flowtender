import type { NodeExecutor, ExecutionItem, ExecutionContext } from '@/types/execution';
import * as path from 'path';
import { runInWorker } from './worker-runtime.ts';

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
    const result = await runInWorker<GaebResult>(
      workerSource,
      { parserPath, fileData, fileName },
      runtime,
    );
    
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
