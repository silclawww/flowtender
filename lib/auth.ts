import { createHash, timingSafeEqual } from 'node:crypto';

const OPERATOR_USERNAME = 'operator';

type HeaderReader = Pick<Headers, 'get'>;

export function secretsMatch(
  candidate: string,
  configuredSecret: string | undefined,
  comparator: typeof timingSafeEqual = timingSafeEqual,
): boolean {
  if (!configuredSecret) return false;

  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  const configuredDigest = createHash('sha256').update(configuredSecret, 'utf8').digest();
  return comparator(candidateDigest, configuredDigest);
}

function bearerToken(headers: HeaderReader): string | null {
  const match = headers.get('authorization')?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

function basicCredentials(headers: HeaderReader): { username: string; password: string } | null {
  const match = headers.get('authorization')?.match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return null;

  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

/**
 * Authorize the human operator boundary. The operator key is deliberately
 * separate from the service-to-service webhook key.
 */
export function isOperatorAuthorized(
  headers: HeaderReader,
  configuredKey = process.env.FLOWTENDER_OPERATOR_KEY,
  configuredServiceKey = process.env.FLOWTENDER_API_KEY,
): boolean {
  if (configuredKey && configuredServiceKey && secretsMatch(configuredKey, configuredServiceKey)) {
    return false;
  }

  const bearer = bearerToken(headers);
  if (bearer && secretsMatch(bearer, configuredKey)) return true;

  const basic = basicCredentials(headers);
  return basic?.username === OPERATOR_USERNAME
    && secretsMatch(basic.password, configuredKey);
}

/** Authorize Tenderly -> Flowtender calls. Basic auth is never accepted here. */
export function isServiceAuthorized(
  headers: HeaderReader,
  configuredKey = process.env.FLOWTENDER_API_KEY,
  configuredOperatorKey = process.env.FLOWTENDER_OPERATOR_KEY,
): boolean {
  if (configuredKey && configuredOperatorKey && secretsMatch(configuredKey, configuredOperatorKey)) {
    return false;
  }

  const bearer = bearerToken(headers);
  return bearer !== null && secretsMatch(bearer, configuredKey);
}
