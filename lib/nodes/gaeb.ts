import type { NodeExecutor, ExecutionItem, ExecutionContext } from '@/types/execution';
import * as path from 'path';

// Path to Tenderly GAEB parser (shared filesystem)
const GAEB_PARSER_PATH = path.join(
  process.cwd(),
  '../tenderly-agent/lib/gaeb-parser-n8n.js'
);

export interface GaebParseConfig {
  file_data_field?: string;  // field name containing base64 file data (default: 'file_data')
  file_name_field?: string;  // field name containing the filename (default: 'file_name')
}

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
    
    // Load the GAEB parser from Tenderly project
    let parseGaebFile: (buf: Buffer, fileName: string) => unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const gaebModule = require(GAEB_PARSER_PATH) as { parseGaebFile: typeof parseGaebFile };
      parseGaebFile = gaebModule.parseGaebFile;
    } catch (err) {
      throw new Error(`gaeb_parse: failed to load GAEB parser from ${GAEB_PARSER_PATH}: ${err}`);
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
