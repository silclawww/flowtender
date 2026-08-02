import { isServiceAuthorized } from './auth.ts';

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
  payload: Record<string, unknown>,
): string {
  switch (path) {
    case 'tender-metadata': {
      const fileType = (payload.file_type as string)
        || (payload.body as Record<string, unknown>)?.file_type as string
        || 'pdf';
      return fileType === 'pdf' ? 'tender-stage1-pdf' : 'tender-stage1-gaeb';
    }
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
): Promise<Response> {
  if (!isServiceAuthorized(request.headers, configuredServiceKey, configuredOperatorKey)) {
    return Response.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let payload: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Existing callers may legitimately send an empty body.
  }

  let workflowId: string;
  try {
    workflowId = resolveWebhookWorkflow(path, payload);
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
  } catch {
    return Response.json(
      { error_code: 'EXECUTION_FAILED' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
