import type { NodeExecutor, ExecutionItem, ExecutionContext } from '@/types/execution';

// Modules allowed in code nodes (safe subset)
const ALLOWED_MODULES = ['crypto', 'util', 'path', 'zlib', 'pdf-parse'];

export const codeExecutor: NodeExecutor = {
  async execute(config, input, context) {
    const code = config.code as string;
    if (!code) return [[...input]]; // passthrough if no code
    
    // Build $input helper
    const $input = {
      first: () => input[0] || { json: {} },
      all: () => input,
      item: input[0] || { json: {} },
    };
    const $json = $input.first().json;
    
    // Build $('nodeId') reference function
    const $nodeRef = (nodeId: string) => ({
      first: () => context.get(nodeId)?.[0] || { json: {} },
      all: () => context.get(nodeId) || [],
    });
    
    // Restricted require
    const safeRequire = (mod: string) => {
      if (!ALLOWED_MODULES.includes(mod)) throw new Error(`require('${mod}') not allowed in code nodes`);
      return require(mod);
    };
    
    try {
      // Wrap code in async function and execute
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        '$input', '$json', '$', 'require', 'JSON',
        `return (async () => { ${code} })()`
      );
      const result = await fn($input, $json, $nodeRef, safeRequire, JSON);
      
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
      const error = err instanceof Error ? err.message : String(err);
      throw new Error(`Code node execution error: ${error}`);
    }
  }
};
