export const TELEMETRY_PERSISTENCE_ERROR_CODE = 'TELEMETRY_PERSISTENCE_FAILED' as const;

export class TelemetryPersistenceError extends Error {
  readonly code = TELEMETRY_PERSISTENCE_ERROR_CODE;

  constructor() {
    super('Telemetry persistence failed');
    this.name = 'TelemetryPersistenceError';
  }
}

interface TelemetryMutationResult {
  data: unknown;
  error: unknown;
}

/**
 * Supabase resolves PostgREST failures instead of rejecting. Require both a
 * clean result and the single row that each telemetry mutation is expected to
 * affect, while discarding all provider error details at this boundary.
 */
export async function persistExactlyOneTelemetryRow(
  mutation: () => PromiseLike<TelemetryMutationResult>,
): Promise<void> {
  try {
    const result = await mutation();
    if (result.error != null || !Array.isArray(result.data) || result.data.length !== 1) {
      throw new TelemetryPersistenceError();
    }
  } catch (error) {
    if (error instanceof TelemetryPersistenceError) throw error;
    throw new TelemetryPersistenceError();
  }
}

export function isTelemetryPersistenceError(
  error: unknown,
): error is TelemetryPersistenceError {
  return error instanceof TelemetryPersistenceError;
}
