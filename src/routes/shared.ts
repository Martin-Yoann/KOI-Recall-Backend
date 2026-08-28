import { createHash } from 'node:crypto';
import type { Context } from 'hono';

import type { AppEnv } from '../middleware/request-context.js';
import { problemType } from '../shared/errors.js';

/**
 * 501 Problem Details body for a capability whose required service or adapter
 * is not configured in the current environment.
 */
export function problem(requestId: string, capability: string) {
  return {
    type: problemType('not-implemented'),
    title: 'Not Implemented',
    status: 501,
    detail: `${capability} is not enabled in this environment because a required service or adapter is not configured.`,
    requestId,
  };
}

export function notFound(context: Context<AppEnv>, resource: string): never {
  return context.json(
    {
      type: problemType('not-found'),
      title: 'Not Found',
      status: 404,
      detail: `${resource} was not found or is not publicly available.`,
      requestId: context.get('requestId'),
    },
    404,
    { 'Content-Type': 'application/problem+json' },
  ) as never;
}

export function dependencyUnavailable(context: Context<AppEnv>, capability: string): never {
  return context.json(
    {
      type: problemType('dependency-unavailable'),
      title: 'Dependency Unavailable',
      status: 503,
      detail: `${capability} could not be completed because a required dependency is unavailable.`,
      requestId: context.get('requestId'),
    },
    503,
    { 'Content-Type': 'application/problem+json' },
  ) as never;
}

/**
 * Derives a stable provider event id from a Vercel Blob webhook payload for
 * deduplication. Falls back to a JSON-derived digest when the payload carries
 * no explicit id so redeliveries still collapse to one row.
 */
export function deriveProviderEventId(payload: Record<string, unknown>): string {
  const explicit = payload.id ?? payload.webhookId ?? payload.eventId;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit.slice(0, 200);
  // Node's createHash gives a synchronous digest (WebCrypto's subtle.digest is
  // async), matching the approach used for draft-token hashing.
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 48)}`;
}
