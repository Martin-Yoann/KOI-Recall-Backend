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

/**
 * Returns true when an error looks like a failed database connection rather
 * than a server-side bug, so the caller can map it to 503 instead of 500.
 * Checks both the error and its `cause` (e.g. a wrapped `fetch failed`).
 */
export function isConnectionError(error: unknown): boolean {
  const candidates: unknown[] = [error];
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause) candidates.push(cause);

  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true;
  }
  return false;
}
