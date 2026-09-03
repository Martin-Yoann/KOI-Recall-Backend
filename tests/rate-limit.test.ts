import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import {
  InMemoryRateLimiter,
  deriveRateLimitKey,
  routeCategoryForPath,
} from '../src/middleware/rate-limit.js';

describe('rate-limit key derivation (T6.1/O6)', () => {
  it('hashes the client source irreversibly and deterministically', () => {
    const a = deriveRateLimitKey('203.0.113.7', 'claims', 'pepper');
    const b = deriveRateLimitKey('203.0.113.7', 'claims', 'pepper');
    expect(a).toBe(b);
    expect(a).not.toContain('203.0.113.7');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different keys for different route categories', () => {
    const claims = deriveRateLimitKey('203.0.113.7', 'claims', 'pepper');
    const checks = deriveRateLimitKey('203.0.113.7', 'product-checks', 'pepper');
    expect(claims).not.toBe(checks);
  });

  it('classifies paths onto quota categories', () => {
    expect(routeCategoryForPath('/v1/recall-campaigns/x')).toBe('campaigns');
    expect(routeCategoryForPath('/v1/recall-campaigns/x/product-checks')).toBe('product-checks');
    expect(routeCategoryForPath('/v1/recall-campaigns/x/claim-drafts')).toBe('claim-drafts');
    expect(routeCategoryForPath('/v1/recall-campaigns/x/claims')).toBe('claims');
    expect(routeCategoryForPath('/v1/claim-drafts/{id}/upload-tokens')).toBe('documents');
    expect(routeCategoryForPath('/webhooks/resend')).toBe('webhooks');
  });

  it('shares the tight case-status-lookups quota with the deprecated legacy lookup', () => {
    expect(routeCategoryForPath('/v1/case-status-lookups')).toBe('case-status-lookups');
    expect(routeCategoryForPath('/v1/consumer-auth/lookup/KOI-B2C4-D6E8F0A1')).toBe(
      'case-status-lookups',
    );
    // Authenticated consumer-account traffic stays in the general bucket.
    expect(routeCategoryForPath('/v1/consumer-auth/claims')).toBe('other');
  });
});

describe('InMemoryRateLimiter (T6.1/O6)', () => {
  it('allows requests within the window and denies past the quota', async () => {
    const limiter = new InMemoryRateLimiter({ claims: 2 }, 60_000);
    const key = `claims:${deriveRateLimitKey('203.0.113.7', 'claims', 'pepper')}`;

    await expect(limiter.check(key)).resolves.toMatchObject({ allowed: true, limit: 2 });
    await expect(limiter.check(key)).resolves.toMatchObject({ allowed: true, remaining: 0 });
    const denied = await limiter.check(key);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets after the window elapses', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new InMemoryRateLimiter({ claims: 1 }, 1_000);
      const key = `claims:${deriveRateLimitKey('203.0.113.7', 'claims', 'pepper')}`;

      await expect(limiter.check(key)).resolves.toMatchObject({ allowed: true });
      await expect(limiter.check(key)).resolves.toMatchObject({ allowed: false });
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(limiter.check(key)).resolves.toMatchObject({ allowed: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rate-limit middleware (T6.1/O6)', () => {
  it('returns 429 with Retry-After once the per-route quota is exhausted', async () => {
    const app = createApp({
      config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    });

    // Default quota for claim-drafts is 30; hammer past it with distinct
    // idempotency keys. Use a unique source so other tests are unaffected.
    let status = 0;
    for (let i = 0; i < 31; i += 1) {
      const response = await app.request(
        '/v1/recall-campaigns/music-lollipop-demo-2026/claim-drafts',
        { method: 'POST', headers: { 'X-Forwarded-For': `203.0.113.99` } },
      );
      status = response.status;
    }
    expect(status).toBe(429);
  });

  it('emits RateLimit headers on allowed requests', async () => {
    const app = createApp({
      config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    });
    const response = await app.request(
      '/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US',
      { headers: { 'X-Forwarded-For': '198.51.100.5' } },
    );
    expect(response.headers.get('RateLimit-Limit')).toBe('120');
    expect(response.headers.get('RateLimit-Remaining')).toBe('119');
  });

  it('lets an injected limiter override the default', async () => {
    const allowAll = {
      check: () => Promise.resolve({ allowed: true, limit: 999 }),
    };
    const app = createApp({
      config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
      rateLimiter: allowAll,
    });
    const response = await app.request(
      '/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US',
    );
    expect(response.headers.get('RateLimit-Limit')).toBe('999');
  });

  it('rate-limits staff login after five attempts from one client', async () => {
    const app = createApp({
      config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    });

    let response: Response | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      response = await app.request('/admin/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.199',
        },
        body: JSON.stringify({ email: 'missing@example.com', password: 'wrong-password' }),
      });
    }

    expect(response?.status).toBe(429);
    expect(response?.headers.get('RateLimit-Limit')).toBe('5');
  });
});
