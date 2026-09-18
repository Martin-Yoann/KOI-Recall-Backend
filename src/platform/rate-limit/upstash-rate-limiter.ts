import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import {
  RATE_LIMIT_QUOTAS,
  RATE_LIMIT_WINDOW_MS,
  type RateLimitDecision,
  type RateLimiter,
} from '../../middleware/rate-limit.js';
import type { SafeLogger } from '../observability/logger.js';

/**
 * Categories where an unreachable store DENIES instead of allowing.
 *
 * These are the brute-force surfaces (a public case-reference probe and staff
 * login). Their legitimate volume is tiny by construction — a real user does not
 * look up ten case references or attempt five logins a minute — so failing
 * closed costs essentially no availability while keeping the control in place
 * during a store outage.
 *
 * Everything else fails open: a brief redis outage must not stop a consumer from
 * reading a recall notice, which is the whole point of the site.
 */
export const FAIL_CLOSED_CATEGORIES: ReadonlySet<string> = new Set([
  'admin-login',
  'case-status-lookups',
]);

/** Store timeouts are treated as unavailable, not as a decision. */
export const DEFAULT_TIMEOUT_MS = 2_000;

/** The subset of a rate-limit response this adapter depends on. */
export interface RateLimitCheckResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Epoch milliseconds at which the window resets. */
  reset: number;
  reason?: string;
}

/**
 * One rate-limit check against the store, for a given identifier and limit.
 * Injected so the failure paths are testable without a live Redis.
 */
export type RateLimitCheck = (identifier: string, limit: number) => Promise<RateLimitCheckResult>;

export interface UpstashRateLimiterOptions {
  quotas?: Record<string, number>;
  windowMs?: number;
  failClosedCategories?: ReadonlySet<string>;
}

/**
 * Shared, cross-instance rate limiting backed by Upstash Redis.
 *
 * The in-memory limiter it replaces counts per lambda instance, so the effective
 * quota was `instances × configured limit` and reset on every cold start — on
 * the brute-force surfaces that meant no limit at all. Backing the counters in
 * Redis makes the configured quota the real quota however far the platform
 * scales out.
 *
 * Sliding windows are used rather than fixed ones: a fixed window lets a caller
 * spend a full quota at the end of one window and another at the start of the
 * next, which on a 10-per-minute probe surface is exactly the gap that matters.
 * This is strictly tighter than the previous fixed-window behaviour at the same
 * configured limits.
 */
export class UpstashRateLimiter implements RateLimiter {
  private readonly quotas: Record<string, number>;
  private readonly windowMs: number;
  private readonly failClosedCategories: ReadonlySet<string>;

  constructor(
    private readonly checkImpl: RateLimitCheck,
    private readonly logger: SafeLogger,
    options: UpstashRateLimiterOptions = {},
  ) {
    this.quotas = options.quotas ?? RATE_LIMIT_QUOTAS;
    this.windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
    this.failClosedCategories = options.failClosedCategories ?? FAIL_CLOSED_CATEGORIES;
  }

  /**
   * Builds the Redis-backed checker. `Ratelimit` fixes its limit at
   * construction while the configured limit varies per category, so one limiter
   * is kept per category and built lazily.
   */
  static fromCredentials(
    url: string,
    token: string,
    logger: SafeLogger,
    options: UpstashRateLimiterOptions = {},
  ): UpstashRateLimiter {
    const redis = new Redis({ url, token });
    const limiters = new Map<string, Ratelimit>();

    const check: RateLimitCheck = async (identifier, limit) => {
      const category = identifier.split(':')[0] ?? 'other';
      let limiter = limiters.get(category);
      if (!limiter) {
        limiter = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(limit, `${options.windowMs ?? RATE_LIMIT_WINDOW_MS} ms`),
          prefix: `koi-rl:${category}`,
          timeout: DEFAULT_TIMEOUT_MS,
        });
        limiters.set(category, limiter);
      }
      return limiter.limit(identifier);
    };

    return new UpstashRateLimiter(check, logger, options);
  }

  async check(key: string): Promise<RateLimitDecision> {
    const category = key.split(':')[0] ?? 'other';
    const limit = this.quotas[category] ?? this.quotas.other ?? 60;
    const failClosed = this.failClosedCategories.has(category);

    try {
      const result = await this.checkImpl(key, limit);

      // The library signals an unreachable store through `reason` rather than by
      // throwing, so an outage takes the same path as a rejection.
      if (result.reason === 'timeout') {
        return this.unavailable(category, limit, failClosed, 'store timeout');
      }

      if (result.success) {
        return { allowed: true, limit: result.limit, remaining: Math.max(result.remaining, 0) };
      }
      return {
        allowed: false,
        limit: result.limit,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
      };
    } catch (error) {
      return this.unavailable(
        category,
        limit,
        failClosed,
        error instanceof Error ? error.name : 'unknown error',
      );
    }
  }

  /**
   * Decides what an unavailable store means for this category, and says so in the
   * log — a silently weakened protection is worse than a visible one.
   */
  private unavailable(
    category: string,
    limit: number,
    failClosed: boolean,
    detail: string,
  ): RateLimitDecision {
    this.logger.error(
      failClosed
        ? 'Rate limit store unavailable; denying a brute-force surface.'
        : 'Rate limit store unavailable; allowing the request.',
      { errorCode: 'rate_limit_store_unavailable', errorMessage: `${category}: ${detail}` },
    );

    if (failClosed) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSeconds: Math.ceil(this.windowMs / 1000),
      };
    }
    return { allowed: true, limit, remaining: Math.max(limit - 1, 0) };
  }
}
