import type { NodeExecutor, ExecutionItem, ExecutionContext } from '@/types/execution';

// Evaluate {{ expression }} templates against execution context
function evalTemplate(
  template: string,
  $input: { first: () => ExecutionItem; all: () => ExecutionItem[] },
  $json: Record<string, unknown>,
  context: ExecutionContext
): string {
  return template.replace(/\{\{\s*([\s\S]+?)\s*\}\}/g, (_match, expr) => {
    try {
      const $nodeRef = (nodeId: string) => ({
        first: () => context.get(nodeId)?.[0] || { json: {} },
        all: () => context.get(nodeId) || [],
      });
      // eslint-disable-next-line no-new-func
      const fn = new Function('$input', '$json', '$', 'JSON', `return (${expr})`);
      const result = fn($input, $json, $nodeRef, JSON);
      if (typeof result === 'string') return result;
      return JSON.stringify(result);
    } catch {
      return '';
    }
  });
}

export const httpRequestExecutor: NodeExecutor = {
  async execute(config, input, context) {
    const method = (config.method as string || 'POST').toUpperCase();
    const $inputHelper = { first: () => input[0] || { json: {} }, all: () => input };
    const $json = $inputHelper.first().json;
    
    const url = evalTemplate(config.url as string || '', $inputHelper, $json, context);
    
    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.headers && typeof config.headers === 'object') {
      for (const [k, v] of Object.entries(config.headers as Record<string, string>)) {
        headers[k] = evalTemplate(v, $inputHelper, $json, context);
      }
    }
    // Auth
    if (config.auth_type === 'bearer' && config.auth_value) {
      headers['Authorization'] = `Bearer ${evalTemplate(config.auth_value as string, $inputHelper, $json, context)}`;
    }
    
    // Body
    let body: string | undefined;
    if (method !== 'GET' && config.body) {
      body = evalTemplate(config.body as string, $inputHelper, $json, context);
    }
    
    // Fetch with retry on 429
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, { method, headers, body });
        
        if (resp.status === 429) {
          const retryAfter = parseInt(resp.headers.get('retry-after') || '5', 10);
          const waitMs = (isNaN(retryAfter) ? 5 : retryAfter) * 1000;
          console.log(`[http_request] 429 rate limit, waiting ${waitMs}ms before retry ${attempt + 1}/${MAX_RETRIES}`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${text.substring(0, 200)}`);
        }
        
        const contentType = resp.headers.get('content-type') || '';
        let responseJson: Record<string, unknown>;
        if (contentType.includes('application/json')) {
          responseJson = await resp.json();
        } else {
          responseJson = { text: await resp.text() };
        }
        
        return [[{ json: responseJson }]];
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES && lastError.message.includes('429')) continue;
        break;
      }
    }
    throw lastError || new Error('HTTP request failed');
  }
};
