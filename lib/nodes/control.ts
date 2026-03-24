import type { NodeExecutor, ExecutionItem, ExecutionContext } from '@/types/execution';

// Helper: evaluate a JS expression string against context
function evalCondition(
  expr: string,
  input: ExecutionItem[],
  context: ExecutionContext
): boolean {
  const $input = { first: () => input[0] || { json: {} }, all: () => input };
  const $json = $input.first().json;
  const $nodeRef = (nodeId: string) => ({
    first: () => context.get(nodeId)?.[0] || { json: {} },
    all: () => context.get(nodeId) || [],
  });
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('$input', '$json', '$', 'JSON', `return !!(${expr})`);
    return fn($input, $json, $nodeRef, JSON);
  } catch {
    return false;
  }
}

// switch — routes input to one of N outputs based on first matching condition
// Config: { rules: [{ condition: string, output_index: number }], fallback_output?: number }
export const switchExecutor: NodeExecutor = {
  async execute(config, input, context) {
    const rules = (config.rules as Array<{ condition: string; output_index: number }>) || [];
    const fallback = (config.fallback_output as number) ?? rules.length;

    // Find number of outputs needed
    const maxOutput = Math.max(fallback, ...rules.map(r => r.output_index));
    const outputs: ExecutionItem[][] = Array.from({ length: maxOutput + 1 }, () => []);

    for (const rule of rules) {
      if (evalCondition(rule.condition, input, context)) {
        outputs[rule.output_index] = [...input];
        return outputs;
      }
    }
    // No rule matched — use fallback
    outputs[fallback] = [...input];
    return outputs;
  }
};

// if — routes to output 0 (true) or output 1 (false)
// Config: { condition: string }
export const ifExecutor: NodeExecutor = {
  async execute(config, input, context) {
    const condition = (config.condition as string) || 'false';
    const result = evalCondition(condition, input, context);
    if (result) {
      return [[...input], []];
    } else {
      return [[], [...input]];
    }
  }
};

// wait — pauses N seconds then passes input through
// Config: { seconds: number }
export const waitExecutor: NodeExecutor = {
  async execute(config, input) {
    const seconds = (config.seconds as number) || 1;
    await new Promise(r => setTimeout(r, seconds * 1000));
    return [[...input]];
  }
};

// respond — marks that an HTTP response should be sent with the current input
// The runner checks for this node type to capture the response payload
// Config: { status_code?: number }
export const respondExecutor: NodeExecutor = {
  async execute(_config, input) {
    // Pass through — runner handles the actual response sending
    return [[...input]];
  }
};

// Registry
export const controlExecutors: Record<string, NodeExecutor> = {
  switch: switchExecutor,
  if: ifExecutor,
  wait: waitExecutor,
  respond: respondExecutor,
};
