import { isServiceAuthorized } from './auth.ts';
import { isTelemetryPersistenceError } from './telemetry-persistence.ts';
import { AdmissionControlError } from './admission-control.ts';
import {
  TenderStagePersistenceError,
  TenderStageTransitionError,
} from './tender-failure-persistence.ts';
import { IngressError, readJsonIngress } from './ingress.ts';

interface WebhookRunResult {
  execution_id: string;
  status: 'done' | 'error';
  response_payload?: Array<{ json: Record<string, unknown> }>;
  error_code?: string;
  duration_ms: number;
}

type RunWebhook = (
  workflowId: string,
  payload: Record<string, unknown>,
  options: { synchronous: true; correlationId?: string },
) => Promise<WebhookRunResult>;

export function resolveWebhookWorkflow(
  path: string,
): string {
  switch (path) {
    // Stage 1 format selection is intentionally deferred until after the
    // runner has claimed admission and bounded/sanitized the business body.
    case 'tender-metadata':
      return 'tender-stage1';
    case 'tender-details':
      return 'tender-stage2-requirements';
    case 'tender-evaluation':
      return 'tender-stage3-evaluation';
    default:
      throw new Error('Unknown webhook');
  }
}

/** Testable request boundary used by the Next.js webhook route. */
export async function handleWebhookRequest(
  request: Request,
  path: string,
  runWebhook: RunWebhook,
  configuredServiceKey = process.env.FLOWTENDER_API_KEY,
  configuredOperatorKey = process.env.FLOWTENDER_OPERATOR_KEY,
  maxIngressBytes?: number,
): Promise<Response> {
  if (!isServiceAuthorized(request.headers, configuredServiceKey, configuredOperatorKey)) {
    return Response.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readJsonIngress(request, maxIngressBytes);
  } catch (error) {
    if (error instanceof IngressError) {
      return Response.json(
        { error_code: error.code },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return Response.json(
      { error_code: 'INVALID_JSON' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let workflowId: string;
  try {
    workflowId = resolveWebhookWorkflow(path);
  } catch {
    return Response.json(
      { error: 'Unknown webhook' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const result = await runWebhook(workflowId, payload, {
      synchronous: true,
      correlationId: request.headers.get('x-correlation-id') ?? undefined,
    });

    if (result.status === 'error') {
      return Response.json(
        { error_code: result.error_code ?? 'EXECUTION_FAILED', execution_id: result.execution_id },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const responseData = result.response_payload?.[0]?.json ?? {
      execution_id: result.execution_id,
      status: result.status,
    };
    return Response.json(responseData, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AdmissionControlError) {
      return Response.json(
        { error_code: error.code },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (error instanceof TenderStageTransitionError || error instanceof TenderStagePersistenceError) {
      return Response.json(
        { error_code: error.code },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (isTelemetryPersistenceError(error)) {
      return Response.json(
        { error_code: error.code },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return Response.json(
      { error_code: 'EXECUTION_FAILED' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
