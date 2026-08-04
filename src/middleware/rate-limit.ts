import { createMiddleware } from 'hono/factory';

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

export function rateLimitMiddleware(rateLimiter: RateLimiter) {
  return createMiddleware<AppEnv>(async (context, next) => {
    const key = `${context.req.method}:${new URL(context.req.url).pathname}`;
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
          type: 'https://api.example.invalid/problems/rate-limited',
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
