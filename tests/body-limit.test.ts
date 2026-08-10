import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';

describe('request body limit (T6.2/O6)', () => {
  const app = createApp({
    config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
  });

  function requestWithLength(path: string, body: string) {
    return app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
      body,
    });
  }

  it('rejects a JSON body larger than the v1 limit with 413', async () => {
    // A valid product-check payload with an oversized identifier value.
    const oversized = {
      mode: 'product_identifiers',
      identifiers: [{ type: 'unit_upc', value: 'x'.repeat(300 * 1024) }],
    };
    const response = await requestWithLength(
      '/v1/recall-campaigns/music-lollipop-demo-2026/product-checks',
      JSON.stringify(oversized),
    );

    expect(response.status).toBe(413);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Payload Too Large', status: 413 });
  });

  it('rejects an oversized streamed body without Content-Length', async () => {
    const body = JSON.stringify({ data: 'x'.repeat(300 * 1024) });
    const response = await app.request(
      new Request('http://localhost/v1/recall-campaigns/music-lollipop-demo-2026/product-checks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
        body,
      }),
    );

    expect(response.status).toBe(413);
  });

  it('accepts a small JSON body', async () => {
    const response = await requestWithLength(
      '/v1/recall-campaigns/music-lollipop-demo-2026/product-checks',
      JSON.stringify({
        mode: 'product_identifiers',
        identifiers: [{ type: 'unit_upc', value: '0123456789012' }],
      }),
    );

    // Placeholder registry: no real product-check provider, so expect 501
    // (contract-complete but not implemented) — the body was accepted.
    expect(response.status).toBe(501);
  });

  it('rejects a webhook body larger than the webhook limit with 413', async () => {
    const oversizedPayload = { data: 'x'.repeat(600 * 1024) }; // ~600 KiB past 512 KiB cap
    const response = await requestWithLength(
      '/webhooks/vercel-blob',
      JSON.stringify(oversizedPayload),
    );

    expect(response.status).toBe(413);
  });
});
