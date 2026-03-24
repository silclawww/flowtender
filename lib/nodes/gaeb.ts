import type { NodeExecutor, ExecutionItem, ExecutionContext } from '@/types/execution';
import * as path from 'path';

// Returns the path to Tenderly GAEB parser at runtime (not build time)
// This must be a function to avoid Turbopack static analysis
function getGaebParserPath(): string {
  return path.join(process.cwd(), '../tenderly-agent/lib/gaeb-parser-n8n.js');
}

export interface GaebParseConfig {
  file_data_field?: string;  // field name containing base64 file data (default: 'file_data')
  file_name_field?: string;  // field name containing the filename (default: 'file_name')
}

// Dynamic require that bypasses Turbopack static analysis
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicRequire = new Function('path', 'return require(path)') as (path: string) => unknown;

export const gaebParseExecutor: NodeExecutor = {
  async execute(config, input) {
    const dataField = (config.file_data_field as string) || 'file_data';
    const nameField = (config.file_name_field as string) || 'file_name';
    
    const item = input[0]?.json || {};
    const fileData = item[dataField] as string;
    const fileName = (item[nameField] as string) || 'upload.avasign';
    
    if (!fileData) {
      throw new Error(`gaeb_parse: no file data found at field '${dataField}'`);
    }
    
    // Load the GAEB parser from Tenderly project (runtime only, not bundled)
    let parseGaebFile: (buf: Buffer, fileName: string) => unknown;
    const parserPath = getGaebParserPath();
    try {
      const gaebModule = dynamicRequire(parserPath) as { parseGaebFile: typeof parseGaebFile };
      parseGaebFile = gaebModule.parseGaebFile;
    } catch (err) {
      throw new Error(`gaeb_parse: failed to load GAEB parser from ${parserPath}: ${err}`);
    }
    
    const buffer = Buffer.from(fileData, 'base64');
    const result = parseGaebFile(buffer, fileName) as {
      gaeb_files: unknown[];
      documents: unknown[];
      has_plans: boolean;
      archive_summary: Record<string, unknown>;
    };
    
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
