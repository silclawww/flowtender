import { NextRequest } from 'next/server';
import { handleWebhookRequest } from '@/lib/webhook-handler';
import { getRunner } from '@/lib/runner';

// Pipeline stages run synchronous LLM calls; allow long serverless execution on Vercel
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string }> }
) {
  const { path } = await params;
  return handleWebhookRequest(
    request,
    path,
    (workflowId, payload, options) => getRunner().run(workflowId, payload, options),
  );
}
