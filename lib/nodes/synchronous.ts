import vm from 'node:vm';

import { WorkflowDeadlineError } from '../retry-errors.ts';
import type { ExecutionRuntime } from '@/types/execution';

export function runSynchronous<T>(
  source: string,
  sandbox: vm.Context,
  runtime?: ExecutionRuntime,
): T {
  if (runtime?.signal?.aborted) throw new WorkflowDeadlineError();
  const remaining = (runtime?.deadline ?? Number.POSITIVE_INFINITY) - Date.now();
  if (remaining <= 0) throw new WorkflowDeadlineError();

  try {
    const timeout = Number.isFinite(remaining)
      ? Math.max(1, Math.min(Math.ceil(remaining), 2_147_483_647))
      : undefined;
    return new vm.Script(source).runInNewContext(
      sandbox,
      timeout === undefined ? undefined : { timeout },
    ) as T;
  } catch (error) {
    if (
      runtime?.signal?.aborted
      || Date.now() >= (runtime?.deadline ?? Number.POSITIVE_INFINITY)
      || (error as NodeJS.ErrnoException)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
    ) {
      throw new WorkflowDeadlineError();
    }
    throw error;
  }
}
