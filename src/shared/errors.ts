const PROBLEM_TYPE_BASE = 'https://api.example.invalid/problems/';

/**
 * Base class for service errors that map to a specific HTTP Problem Details
 * response. Subclasses declare the {@link status}, {@link type} suffix, and
 * {@link title}; the thrown message becomes the `detail`. The Hono
 * `onError` handler instanceof-checks this base to render a uniform
 * `application/problem+json` body, mirroring how
 * {@link NotImplementedServiceError} already maps to 501.
 */
export abstract class HttpProblemError extends Error {
  abstract readonly status: number;
  abstract readonly type: string;
  abstract readonly title: string;

  constructor(detail: string) {
    super(detail);
    this.name = this.constructor.name;
  }
}

/** A problem type URI under the API's canonical problem namespace. */
export function problemType(suffix: string): string {
  return `${PROBLEM_TYPE_BASE}${suffix}`;
}

/**
 * Thrown when a draft token is missing, unknown, or the draft is no longer
 * active or has expired. Maps to 410 Gone.
 */
export class DraftExpiredOrInvalidError extends HttpProblemError {
  readonly status = 410;
  readonly type = problemType('gone');
  readonly title = 'Gone';
}

/**
 * Thrown when an upload exceeds the campaign version's
 * `maximumFileSizeBytes` for its evidence category. Maps to 413 Payload Too
 * Large.
 */
export class PayloadTooLargeError extends HttpProblemError {
  readonly status = 413;
  readonly type = problemType('payload-too-large');
  readonly title = 'Payload Too Large';
}

/**
 * Thrown when the requested media type is not in the campaign version's
 * `allowedMimeTypes` for its evidence category. Maps to 415 Unsupported
 * Media Type.
 */
export class UnsupportedMediaTypeError extends HttpProblemError {
  readonly status = 415;
  readonly type = problemType('unsupported-media-type');
  readonly title = 'Unsupported Media Type';
}

/**
 * Thrown when campaign evidence rules (category present, file counts within
 * `minimumFiles`/`maximumFiles`, conditional fields) are not satisfied. Maps
 * to 422 Unprocessable Entity.
 */
export class EvidenceRulesViolationError extends HttpProblemError {
  readonly status = 422;
  readonly type = problemType('unprocessable-entity');
  readonly title = 'Unprocessable Entity';
}

/**
 * Thrown when a referenced draft or document cannot be found or is not
 * accessible in the current context. Maps to 404 Not Found.
 */
export class ResourceNotFoundError extends HttpProblemError {
  readonly status = 404;
  readonly type = problemType('not-found');
  readonly title = 'Not Found';
}

/**
 * Thrown when a claim submission conflicts with a previous idempotency key or
 * an already-consumed draft. Maps to 409 Conflict.
 */
export class ClaimConflictError extends HttpProblemError {
  readonly status = 409;
  readonly type = problemType('conflict');
  readonly title = 'Conflict';
}

/**
 * Thrown when a syntactically valid claim fails domain validation. Maps to
 * 422 Unprocessable Entity.
 */
export class ClaimValidationError extends HttpProblemError {
  readonly status = 422;
  readonly type = problemType('unprocessable-entity');
  readonly title = 'Unprocessable Entity';
}

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
  return errorHasCode(error, isAvailabilityCode);
}

/**
 * Returns true when an error is a PostgreSQL unique-violation (SQLSTATE
 * 23505), e.g. a duplicate insert against a unique index. Used for idempotent
 * webhook deduplication where a redelivery is expected and safe to ignore.
 */
export function isUniqueViolation(error: unknown): boolean {
  return errorHasCode(error, (code) => code === '23505');
}

function errorHasCode(error: unknown, predicate: (code: string) => boolean): boolean {
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
    if (typeof errorRecord.code === 'string' && predicate(errorRecord.code)) return true;
    if (errorRecord.cause !== undefined) candidates.push(errorRecord.cause);
    if (Array.isArray(errorRecord.errors)) {
      for (const nestedError of errorRecord.errors as unknown[]) candidates.push(nestedError);
    }
  }

  return false;
}
