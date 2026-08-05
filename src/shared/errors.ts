export class NotImplementedServiceError extends Error {
  constructor(readonly capability: string) {
    super(`${capability} is defined by contract but is not implemented in the Phase 1 skeleton.`);
    this.name = 'NotImplementedServiceError';
  }
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  requestId?: string;
  errors?: Array<{ path: string; message: string }>;
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const POSTGRES_AVAILABILITY_ERROR_CODES = new Set(['57P01', '57P02', '57P03', '53300']);
const MAX_ERROR_OBJECTS = 64;

function isAvailabilityCode(code: unknown): boolean {
  return (
    typeof code === 'string' &&
    (CONNECTION_ERROR_CODES.has(code) ||
      /^08[A-Z0-9]{3}$/.test(code) ||
      POSTGRES_AVAILABILITY_ERROR_CODES.has(code))
  );
}

/**
 * Returns true when an error looks like a failed database connection rather
 * than a server-side bug, so the caller can map it to 503 instead of 500.
 * Checks both the error and its `cause` (e.g. a wrapped `fetch failed`).
 */
export function isConnectionError(error: unknown): boolean {
  const candidates: unknown[] = [error];
  const visited = new Set<object>();
  let examined = 0;

  while (candidates.length > 0 && examined < MAX_ERROR_OBJECTS) {
    const candidate = candidates.shift();
    if (typeof candidate !== 'object' || candidate === null) continue;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    examined += 1;

    const errorRecord = candidate as { code?: unknown; cause?: unknown; errors?: unknown };
    if (isAvailabilityCode(errorRecord.code)) return true;
    if (errorRecord.cause !== undefined) candidates.push(errorRecord.cause);
    if (Array.isArray(errorRecord.errors)) candidates.push(...errorRecord.errors);
  }

  return false;
}
