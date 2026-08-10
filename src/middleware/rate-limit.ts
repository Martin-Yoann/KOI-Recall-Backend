import { createHash } from 'node:crypto';

import { createMiddleware } from 'hono/factory';

import { problemType } from '../shared/errors.js';
import type { AppEnv } from './request-context.js';

export interface RateLimitDecision {
  allowed: boolean;
  limit?: number;
  remaining?: number;
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitDecision>;
}

export const allowAllRateLimiter: RateLimiter = {
  check() {
    return Promise.resolve({ allowed: true });
  },
};

/**
 * Derives the rate-limit key: an irreversible hash of
 * `routeCategory:clientSource` (T6.1/O6). The client source is only ever
 * hashed — never emitted or logged — and the route category gives different
 * endpoints independent quotas. A per-deployment pepper prevents precomputed
 * rainbow mapping of well-known sources.
 */
export function deriveRateLimitKey(
  clientSource: string,
  routeCategory: string,
  pepper: string,
): string {
  return createHash('sha256')
    .update(`${routeCategory}:${clientSource}:${pepper}`, 'utf8')
    .digest('hex');
}

/** Maps a request path onto its quota category (T6.1: per-endpoint quotas). */
export function routeCategoryForPath(pathname: string): string {
  if (pathname.startsWith('/v1/recall-campaigns/')) {
    const remainder = pathname.slice('/v1/recall-campaigns/'.length);
    if (remainder.includes('/product-checks')) return 'product-checks';
    if (remainder.includes('/claim-drafts') && !remainder.includes('/claims'))
      return 'claim-drafts';
    if (remainder.includes('/claims')) return 'claims';
    return 'campaigns';
  }
  if (pathname.startsWith('/v1/claim-drafts/')) return 'documents';
  if (pathname.startsWith('/webhooks/')) return 'webhooks';
  return 'other';
}

/** Per-category quota: requests per window (T6.1: different endpoints differ). */
export const RATE_LIMIT_QUOTAS: Record<string, number> = {
  campaigns: 120,
  'product-checks': 60,
  'claim-drafts': 30,
  claims: 20,
  documents: 120,
  webhooks: 200,
  other: 60,
};

export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

interface WindowState {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window in-memory rate limiter. Suitable for single-instance Vercel
 * Node functions and local dev; a shared store (e.g. Upstash) is the
 * multi-instance follow-up. Keys are already hashed by the middleware.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly quotas: Record<string, number> = RATE_LIMIT_QUOTAS,
    private readonly windowMs: number = RATE_LIMIT_WINDOW_MS,
  ) {}

  check(key: string): Promise<RateLimitDecision> {
    const category = key.split(':')[0] ?? 'other';
    const limit = this.quotas[category] ?? RATE_LIMIT_QUOTAS.other ?? 60;
    const now = Date.now();

    // The key carries the category prefix before the hash so one map can hold
    // every category without leaking the raw source.
    const state = this.windows.get(key);
    if (!state || state.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return Promise.resolve({ allowed: true, limit, remaining: limit - 1 });
    }

    state.count += 1;
    if (state.count > limit) {
      return Promise.resolve({
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSeconds: Math.ceil((state.resetAt - now) / 1000),
      });
    }
    return Promise.resolve({ allowed: true, limit, remaining: Math.max(limit - state.count, 0) });
  }
}

export function rateLimitMiddleware(rateLimiter: RateLimiter) {
  return createMiddleware<AppEnv>(async (context, next) => {
    const pathname = new URL(context.req.url).pathname;
    const category = routeCategoryForPath(pathname);
    const key = `${category}:${deriveRateLimitKey(
      context.get('clientSource'),
      category,
      'rate-limit-pepper',
    )}`;
    const decision = await rateLimiter.check(key);

    if (decision.limit !== undefined) context.header('RateLimit-Limit', String(decision.limit));
    if (decision.remaining !== undefined)
      context.header('RateLimit-Remaining', String(decision.remaining));

    if (!decision.allowed) {
      if (decision.retryAfterSeconds !== undefined) {
        context.header('Retry-After', String(decision.retryAfterSeconds));
      }
      return context.json(
        {
          type: problemType('rate-limited'),
          title: 'Too Many Requests',
          status: 429,
          detail: 'The request rate limit has been exceeded.',
          requestId: context.get('requestId'),
        },
        429,
        { 'Content-Type': 'application/problem+json' },
      );
    }

    await next();
  });
}
