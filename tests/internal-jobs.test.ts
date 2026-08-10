import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { requireCronSecret } from '../src/routes/internal-jobs.js';

describe('internal job CRON_SECRET auth (T5.2/O5)', () => {
  it('rejects a missing secret with 401', async () => {
    const app = createApp({
      config: loadConfig({
        CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
        CRON_SECRET: 'super-secret',
      }),
    });
    const response = await app.request('/internal/jobs/outbox');
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Unauthorized', status: 401 });
  });

  it('rejects an invalid secret with 401', async () => {
    const app = createApp({
      config: loadConfig({
        CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
        CRON_SECRET: 'super-secret',
      }),
    });
    const response = await app.request('/internal/jobs/cleanup-drafts', {
      headers: { Authorization: 'Bearer wrong-secret' },
    });
    expect(response.status).toBe(401);
  });

  it('accepts the configured secret and runs the job handler', async () => {
    const app = createApp({
      config: loadConfig({
        CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
        CRON_SECRET: 'super-secret',
      }),
    });
    const response = await app.request('/internal/jobs/outbox', {
      headers: { Authorization: 'Bearer super-secret' },
    });
    // Default handler is not-implemented -> 501; the gate passed (not 401).
    expect(response.status).toBe(501);
  });

  it('rejects when no CRON_SECRET is configured', async () => {
    const app = createApp({
      config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    });
    const response = await app.request('/internal/jobs/outbox', {
      headers: { Authorization: 'Bearer anything' },
    });
    expect(response.status).toBe(401);
  });

  it('requireCronSecret compares exactly and tolerates the Bearer prefix', () => {
    const context = { req: { header: () => 'Bearer abc' } };
    expect(requireCronSecret('abc', context as never)).toBe(true);
    expect(requireCronSecret('ABC', context as never)).toBe(false);
    expect(requireCronSecret(undefined, context as never)).toBe(false);
  });
});
