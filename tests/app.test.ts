import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';

function testApp() {
  return createApp({
    config: loadConfig({
      APP_ENV: 'local',
      CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
    }),
  });
}

describe('HTTP application shell', () => {
  it('serves a liveness check with security and request-id headers', async () => {
    const response = await testApp().request('/health/live', {
      headers: { 'X-Request-Id': 'test-request-001' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toBe('test-request-001');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'koi-recall-api',
    });
  });

  it('serves readiness based on required configuration', async () => {
    const configured = await testApp().request('/health/ready');
    expect(configured.status).toBe(503); // no DATABASE_URL in test config

    const readyApp = createApp({
      config: loadConfig({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/koi_recall',
        CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
      }),
    });
    const ready = await readyApp.request('/health/ready');
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: 'ok', service: 'koi-recall-api' });
  });

  it('accepts a Neon integration fallback when DATABASE_URL is absent', async () => {
    const readyApp = createApp({
      config: loadConfig({
        koi_DATABASE_URL:
          'postgresql://user:pass@ep-koi-test-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
        CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
      }),
    });
    const ready = await readyApp.request('/health/ready');
    expect(ready.status).toBe(200);
  });

  it('honours an injected ready check', async () => {
    const app = createApp({
      config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
      readyCheck: () => Promise.resolve(false),
    });
    const response = await app.request('/health/ready');
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Not Ready', status: 503 });
  });

  it('replaces an unsafe request id', async () => {
    const response = await testApp().request('/health/live', {
      headers: { 'X-Request-Id': 'unsafe request id\n' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('allows only configured CORS origins', async () => {
    const allowed = await testApp().request('/health/live', {
      headers: { Origin: 'https://consumer.example.com' },
    });
    const denied = await testApp().request('/health/live', {
      headers: { Origin: 'https://attacker.example' },
    });

    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://consumer.example.com');
    expect(allowed.headers.get('Access-Control-Expose-Headers')).toContain('Content-Disposition');
    expect(allowed.headers.get('Access-Control-Expose-Headers')).toContain(
      'X-Refund-Export-Batch-Id',
    );
    expect(allowed.headers.get('Access-Control-Expose-Headers')).toContain(
      'X-Refund-Export-Sha256',
    );
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('returns 501 with a configuration explanation when a required service is not configured', async () => {
    const response = await testApp().request(
      '/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US',
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(501);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    expect(body).toMatchObject({
      title: 'Not Implemented',
      status: 501,
    });
    expect(body.detail).toContain('required service or adapter is not configured');
    expect(body).not.toHaveProperty('storagePathname');
  });

  it('converts invalid requests into 400 Problem Details', async () => {
    const response = await testApp().request(
      '/v1/recall-campaigns/music-lollipop-demo-2026/product-checks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shape: '', flavor: '', lotCode: '', dateCode: '' }),
      },
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    expect(body).toMatchObject({ title: 'Invalid Request', status: 400 });
    expect(body.errors).toBeInstanceOf(Array);
  });

  it('returns 429 from an injected shared rate limiter', async () => {
    const app = createApp({
      config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
      rateLimiter: {
        check() {
          return Promise.resolve({
            allowed: false,
            limit: 10,
            remaining: 0,
            retryAfterSeconds: 30,
          });
        },
      },
    });
    const response = await app.request(
      '/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US',
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('RateLimit-Limit')).toBe('10');
  });
});
