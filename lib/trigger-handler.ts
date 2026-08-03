import { AdmissionControlError } from './admission-control.ts';
import { isServiceAuthorized } from './auth.ts';
import { IngressError, readJsonIngress } from './ingress.ts';
import { isTelemetryPersistenceError } from './telemetry-persistence.ts';

interface TriggerRunResult {
  execution_id: string;
  status: 'done' | 'error';
  response_payload?: Array<{ json: Record<string, unknown> }>;
  error_code?: string;
  duration_ms: number;
}

type RunTrigger = (
  workflowId: string,
  payload: Record<string, unknown>,
  options: { synchronous: true; correlationId?: string },
) => Promise<TriggerRunResult>;

const noStore = { 'Cache-Control': 'no-store' };

export async function handleTriggerRequest(
  request: Request,
  workflowId: string,
  runTrigger: RunTrigger,
  configuredServiceKey = process.env.FLOWTENDER_API_KEY,
  configuredOperatorKey = process.env.FLOWTENDER_OPERATOR_KEY,
  maxIngressBytes?: number,
): Promise<Response> {
  if (!isServiceAuthorized(request.headers, configuredServiceKey, configuredOperatorKey)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: noStore });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readJsonIngress(request, maxIngressBytes);
  } catch (error) {
    if (error instanceof IngressError) {
      return Response.json({ error_code: error.code }, { status: error.status, headers: noStore });
    }
    return Response.json({ error_code: 'INVALID_JSON' }, { status: 400, headers: noStore });
  }

  try {
    const result = await runTrigger(workflowId, payload, {
      synchronous: true,
      correlationId: request.headers.get('x-correlation-id') ?? undefined,
    });
    if (result.status === 'error') {
      return Response.json(
        { error_code: result.error_code ?? 'EXECUTION_FAILED', execution_id: result.execution_id },
        { status: 500, headers: noStore },
      );
    }
    return Response.json(
      result.response_payload?.[0]?.json ?? {
        execution_id: result.execution_id,
        status: result.status,
      },
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof AdmissionControlError) {
      return Response.json({ error_code: error.code }, { status: error.status, headers: noStore });
    }
    if (isTelemetryPersistenceError(error)) {
      return Response.json({ error_code: error.code }, { status: 503, headers: noStore });
    }
    return Response.json({ error_code: 'EXECUTION_FAILED' }, { status: 500, headers: noStore });
  }
}
