import type {
  NodeExecutor,
  ExecutionItem,
  ExecutionContext,
  ExecutionRuntime,
} from '@/types/execution';
import {
  NonRetryableError,
  WorkflowDeadlineError,
  isNonRetryableError,
} from '../retry-errors.ts';

const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 5_000;
const MAX_ITEM_BATCH = 10;

function requestTimeout(timeoutMs: number): NonRetryableError {
  return new NonRetryableError(`HTTP request timed out after ${timeoutMs}ms`);
}

function retryAfterDelayMs(value: string | null): number {
  const delaySeconds = value?.trim() ?? '';
  if (!/^[0-9]+$/.test(delaySeconds)) return MAX_RETRY_AFTER_MS;
  const seconds = Number(delaySeconds);
  return Number.isFinite(seconds) ? seconds * 1000 : Number.POSITIVE_INFINITY;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    throw new NonRetryableError('HTTP response cleanup failed');
  }
}

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
      const fn = new Function('$input', '$json', '$', 'JSON', 'process', `return (${expr})`);
      const result = fn($input, $json, $nodeRef, JSON, process);
      if (typeof result === 'string') return result;
      return JSON.stringify(result);
    } catch {
      return '';
    }
  });
}

async function executeRequest(
  config: Record<string, unknown>,
  input: ExecutionItem[],
  context: ExecutionContext,
  runtime?: ExecutionRuntime,
): Promise<ExecutionItem> {
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

    // Fetch with retry on 429 and configurable timeout (default 120s)
    const configuredTimeoutMs = typeof config.timeout_ms === 'number' ? config.timeout_ms : 120_000;
    const workflowDeadline = runtime?.deadline ?? Number.POSITIVE_INFINITY;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const attemptStartedAt = Date.now();
      const workflowTimeRemaining = workflowDeadline - attemptStartedAt;
      if (workflowTimeRemaining <= 0) throw new WorkflowDeadlineError();
      const timeoutMs = Math.min(configuredTimeoutMs, workflowTimeRemaining);
      const timeoutIsWorkflowDeadline = configuredTimeoutMs >= workflowTimeRemaining;
      const controller = new AbortController();
      const attemptDeadline = attemptStartedAt + timeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { method, headers, body, signal: controller.signal });

        if (resp.status === 429) {
          await cancelResponseBody(resp);
          if (Date.now() >= workflowDeadline) throw new WorkflowDeadlineError();
          if (Date.now() >= attemptDeadline) throw requestTimeout(timeoutMs);
          if (attempt === MAX_RETRIES) {
            throw new NonRetryableError('HTTP 429: rate limit');
          }
          const requestedWaitMs = retryAfterDelayMs(resp.headers.get('retry-after'));
          const remainingMs = Math.max(0, attemptDeadline - Date.now());
          if (remainingMs <= 0) {
            throw Date.now() >= workflowDeadline
              ? new WorkflowDeadlineError()
              : requestTimeout(timeoutMs);
          }
          const waitMs = Math.min(requestedWaitMs, MAX_RETRY_AFTER_MS, remainingMs);
          console.log(`[http_request] 429 rate limit, waiting ${waitMs}ms before retry ${attempt + 1}/${MAX_RETRIES}`);
          await new Promise(r => setTimeout(r, waitMs));
          if (Date.now() >= attemptDeadline) {
            throw Date.now() >= workflowDeadline
              ? new WorkflowDeadlineError()
              : requestTimeout(timeoutMs);
          }
          continue;
        }

        if (!resp.ok) {
          await resp.text();
          throw new Error(`HTTP ${resp.status}`);
        }
        
        const contentType = resp.headers.get('content-type') || '';
        let responseJson: Record<string, unknown>;
        if (contentType.includes('application/json')) {
          responseJson = await resp.json();
        } else {
          responseJson = { text: await resp.text() };
        }
        if (Date.now() >= workflowDeadline) throw new WorkflowDeadlineError();
        if (Date.now() >= attemptDeadline) throw requestTimeout(timeoutMs);

        return { json: responseJson };
      } catch (err) {
        if (isNonRetryableError(err)) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (Date.now() >= workflowDeadline) throw new WorkflowDeadlineError();
        if (lastError.name === 'AbortError' && timeoutIsWorkflowDeadline) {
          throw new WorkflowDeadlineError();
        }
        if (lastError.name === 'AbortError' || Date.now() >= attemptDeadline) {
          throw requestTimeout(timeoutMs);
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('HTTP request failed');
}

export const httpRequestExecutor: NodeExecutor = {
  async execute(config, input, context, runtime) {
    if (config.process_each_item !== true) {
      return [[await executeRequest(config, input, context, runtime)]];
    }
    if (input.length > MAX_ITEM_BATCH) {
      throw new NonRetryableError('HTTP item batch too large');
    }

    const output: ExecutionItem[] = [];
    for (const item of input) {
      output.push(await executeRequest(config, [item], context, runtime));
    }
    return [output];
  }
};
