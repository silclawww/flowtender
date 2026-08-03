export const FLOW_INGRESS_MAX_BYTES = 75 * 1024 * 1024;

export class IngressError extends Error {
  readonly status: 400 | 413;
  readonly code: 'INVALID_JSON' | 'PAYLOAD_TOO_LARGE';

  constructor(status: 400 | 413, code: 'INVALID_JSON' | 'PAYLOAD_TOO_LARGE') {
    super(code);
    this.name = 'IngressError';
    this.status = status;
    this.code = code;
  }
}

function declaredLength(headers: Pick<Headers, 'get'>): number | null {
  const raw = headers.get('content-length');
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new IngressError(400, 'INVALID_JSON');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new IngressError(413, 'PAYLOAD_TOO_LARGE');
  return value;
}

export async function readJsonIngress(
  request: Pick<Request, 'headers' | 'body' | 'arrayBuffer'>,
  maxBytes = FLOW_INGRESS_MAX_BYTES,
): Promise<Record<string, unknown>> {
  const length = declaredLength(request.headers);
  if (length !== null && length > maxBytes) {
    throw new IngressError(413, 'PAYLOAD_TOO_LARGE');
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new IngressError(413, 'PAYLOAD_TOO_LARGE');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const value = Buffer.from(await request.arrayBuffer());
    bytes = value.byteLength;
    if (bytes > maxBytes) throw new IngressError(413, 'PAYLOAD_TOO_LARGE');
    chunks.push(value);
  }

  if (bytes === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new IngressError(400, 'INVALID_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IngressError(400, 'INVALID_JSON');
  }
  return parsed as Record<string, unknown>;
}
