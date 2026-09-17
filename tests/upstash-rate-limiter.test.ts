/* eslint-disable @typescript-eslint/require-await -- test doubles resolve synchronously */
import { describe, expect, it, vi } from 'vitest';

import { createRateLimiter, resolveRateLimitCredentials } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRateLimiter, RATE_LIMIT_QUOTAS } from '../src/middleware/rate-limit.js';
import type { SafeLogger, SafeLogFields } from '../src/platform/observability/logger.js';
import {
  UpstashRateLimiter,
  type RateLimitCheck,
  type RateLimitCheckResult,
} from '../src/platform/rate-limit/upstash-rate-limiter.js';

function makeLogger(): SafeLogger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    info: (_message: string, _fields?: SafeLogFields) => {},
    error: (message: string, _fields?: SafeLogFields) => {
      errors.push(message);
    },
  };
}

function allowing(): RateLimitCheckResult {
  return { success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 };
}

describe('UpstashRateLimiter', () => {
  it('allows a request under the limit and reports the remaining budget', async () => {
    const check = vi.fn(async () => allowing());
    const limiter = new UpstashRateLimiter(check, makeLogger());

    const decision = await limiter.check('case-status-lookups:abc');

    expect(decision).toEqual({ allowed: true, limit: 10, remaining: 9 });
  });

  it('denies over the limit with a retry hint derived from the store reset', async () => {
    const check = vi.fn(async () => ({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 30_000,
    }));
    const limiter = new UpstashRateLimiter(check, makeLogger());

    const decision = await limiter.check('case-status-lookups:abc');

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it('passes the category quota as the limit, so categories keep their own budgets', async () => {
    const seen: Array<{ key: string; limit: number }> = [];
    const check: RateLimitCheck = async (key, limit) => {
      seen.push({ key, limit });
      return allowing();
    };
    const limiter = new UpstashRateLimiter(check, makeLogger());

    await limiter.check('campaigns:x');
    await limiter.check('case-status-lookups:x');

    expect(seen).toEqual([
      { key: 'campaigns:x', limit: RATE_LIMIT_QUOTAS.campaigns },
      { key: 'case-status-lookups:x', limit: RATE_LIMIT_QUOTAS['case-status-lookups'] },
    ]);
  });

  it('falls back to the "other" quota for an unknown category', async () => {
    const seen: number[] = [];
    const check: RateLimitCheck = async (_key, limit) => {
      seen.push(limit);
      return allowing();
    };
    await new UpstashRateLimiter(check, makeLogger()).check('brand-new-category:x');

    expect(seen).toEqual([RATE_LIMIT_QUOTAS.other]);
  });

  describe('when the store is unreachable', () => {
    it('denies a brute-force surface and logs it', async () => {
      const logger = makeLogger();
      const check: RateLimitCheck = async () => {
        throw new Error('ECONNREFUSED');
      };
      const limiter = new UpstashRateLimiter(check, logger);

      const decision = await limiter.check('admin-login:x');

      expect(decision.allowed).toBe(false);
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
      expect(logger.errors.join(' ')).toContain('denying a brute-force surface');
    });

    it('denies the public case-reference probe too', async () => {
      const check: RateLimitCheck = async () => {
        throw new Error('ECONNREFUSED');
      };
      const decision = await new UpstashRateLimiter(check, makeLogger()).check(
        'case-status-lookups:x',
      );

      expect(decision.allowed).toBe(false);
    });

    it('allows ordinary traffic, so an outage cannot hide a recall notice', async () => {
      const logger = makeLogger();
      const check: RateLimitCheck = async () => {
        throw new Error('ECONNREFUSED');
      };
      const limiter = new UpstashRateLimiter(check, logger);

      const decision = await limiter.check('campaigns:x');

      expect(decision.allowed).toBe(true);
      expect(logger.errors.join(' ')).toContain('allowing the request');
    });

    it('treats a store timeout the same as an error', async () => {
      const logger = makeLogger();
      const check: RateLimitCheck = async () => ({
        success: true,
        limit: 10,
        remaining: 9,
        reset: 0,
        reason: 'timeout',
      });
      const limiter = new UpstashRateLimiter(check, logger);

      expect((await limiter.check('admin-login:x')).allowed).toBe(false);
      expect((await limiter.check('campaigns:x')).allowed).toBe(true);
      expect(logger.errors).toHaveLength(2);
    });

    it('never lets a store failure become a thrown error', async () => {
      // A throw here would surface as a 500 on every request, turning a rate-limit
      // outage into an application outage.
      const check: RateLimitCheck = async () => {
        throw new Error('boom');
      };
      const limiter = new UpstashRateLimiter(check, makeLogger());

      await expect(limiter.check('campaigns:x')).resolves.toBeDefined();
      await expect(limiter.check('admin-login:x')).resolves.toBeDefined();
    });
  });
});

describe('createRateLimiter', () => {
  it('uses Upstash when both credentials are configured', () => {
    const limiter = createRateLimiter(
      loadConfig({
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'token',
      }),
    );

    expect(limiter).toBeInstanceOf(UpstashRateLimiter);
  });

  it('accepts the legacy Vercel-KV names the marketplace integration provisions', () => {
    // Vercel's Upstash integration injects KV_REST_API_* even though the endpoint
    // is an Upstash REST URL, so this pairing has to work.
    const limiter = createRateLimiter(
      loadConfig({
        KV_REST_API_URL: 'https://example.upstash.io',
        KV_REST_API_TOKEN: 'token',
      }),
    );

    expect(limiter).toBeInstanceOf(UpstashRateLimiter);
  });

  it('prefers the Upstash-native names when both pairings are present', () => {
    const resolved = resolveRateLimitCredentials(
      loadConfig({
        UPSTASH_REDIS_REST_URL: 'https://native.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'native-token',
        KV_REST_API_URL: 'https://kv.upstash.io',
        KV_REST_API_TOKEN: 'kv-token',
      }),
    );

    expect(resolved).toEqual({ url: 'https://native.upstash.io', token: 'native-token' });
  });

  it('resolves the legacy pair when only that one is present', () => {
    const resolved = resolveRateLimitCredentials(
      loadConfig({ KV_REST_API_URL: 'https://kv.upstash.io', KV_REST_API_TOKEN: 'kv-token' }),
    );

    expect(resolved).toEqual({ url: 'https://kv.upstash.io', token: 'kv-token' });
  });

  it('resolves to null when the pair is incomplete, mixing names is allowed', () => {
    expect(resolveRateLimitCredentials(loadConfig({}))).toBeNull();
    expect(
      resolveRateLimitCredentials(loadConfig({ UPSTASH_REDIS_REST_URL: 'https://a.upstash.io' })),
    ).toBeNull();
    // A token without a URL is equally unusable.
    expect(resolveRateLimitCredentials(loadConfig({ KV_REST_API_TOKEN: 't' }))).toBeNull();
    // But the two schemes may be mixed — they describe the same service.
    expect(
      resolveRateLimitCredentials(
        loadConfig({ UPSTASH_REDIS_REST_URL: 'https://a.upstash.io', KV_REST_API_TOKEN: 't' }),
      ),
    ).toEqual({ url: 'https://a.upstash.io', token: 't' });
  });

  it('falls back to the in-memory limiter without credentials', () => {
    expect(createRateLimiter(loadConfig({}))).toBeInstanceOf(InMemoryRateLimiter);
  });

  it('falls back when only a URL is set — a URL alone cannot authenticate', () => {
    expect(
      createRateLimiter(loadConfig({ UPSTASH_REDIS_REST_URL: 'https://example.upstash.io' })),
    ).toBeInstanceOf(InMemoryRateLimiter);
    expect(
      createRateLimiter(loadConfig({ KV_REST_API_URL: 'https://example.upstash.io' })),
    ).toBeInstanceOf(InMemoryRateLimiter);
  });
});
