export class NonRetryableError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export class WorkflowDeadlineError extends NonRetryableError {
  constructor() {
    super('WORKFLOW_EXECUTION_DEADLINE_EXCEEDED');
    this.name = 'WorkflowDeadlineError';
  }
}

export function isNonRetryableError(error: unknown): error is NonRetryableError {
  return error instanceof NonRetryableError;
}
