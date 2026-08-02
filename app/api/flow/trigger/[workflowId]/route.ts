import type { NextRequest } from 'next/server';
import { getRunner } from '@/lib/runner';
import { handleTriggerRequest } from '@/lib/trigger-handler';

export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> },
) {
  const { workflowId } = await params;
  return handleTriggerRequest(
    request,
    workflowId,
    (id, payload, options) => getRunner().run(id, payload, options),
  );
}
