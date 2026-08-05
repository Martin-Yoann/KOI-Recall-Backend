import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { ProductCheckResponse } from '../src/contracts/toc.js';
import type {
  ProductCheckResult,
  ProductCheckService,
} from '../src/modules/product-checks/service.js';

const baseBody = { shape: 'Bear', flavor: 'Peach', lotCode: 'ML-2406-A', dateCode: '06/2024' };

function appWith(productChecks: ProductCheckService) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: { ...base.services, productChecks },
    platform: base.platform,
  };
  return createApp({
    config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    registry,
  });
}

function service(check: ProductCheckService['check']): ProductCheckService {
  return { check };
}

async function postCheck(app: ReturnType<typeof appWith>, body: unknown) {
  return app.request('/v1/recall-campaigns/music-lollipop-demo-2026/product-checks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/recall-campaigns/{slug}/product-checks', () => {
  it('returns 200 with a potential match against an affected product', async () => {
    const result: ProductCheckResult = {
      result: 'potential_match',
      message: 'The product may be included in this recall.',
      checkedCampaignVersion: 1,
    };
    const response = await postCheck(appWith(service(() => Promise.resolve(result))), baseBody);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ProductCheckResponse;
    expect(body).toMatchObject({
      result: 'potential_match',
      message: 'The product may be included in this recall.',
      checkedCampaignVersion: 1,
      disclaimer: 'This check is preliminary and is not a final eligibility decision.',
    });
  });

  it('returns 200 with not matched when no affected product aligns', async () => {
    const result: ProductCheckResult = {
      result: 'not_matched',
      message: 'No affected product matches the shape, flavor, and lot details provided.',
      checkedCampaignVersion: 1,
    };
    const response = await postCheck(appWith(service(() => Promise.resolve(result))), baseBody);

    expect(response.status).toBe(200);
    expect(((await response.json()) as ProductCheckResponse).result).toBe('not_matched');
  });

  it('returns 404 when the campaign is not found or not publicly visible', async () => {
    const response = await postCheck(appWith(service(() => Promise.resolve(null))), baseBody);

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Not Found', status: 404 });
  });

  it('returns 503 when the database connection fails', async () => {
    const response = await postCheck(
      appWith(
        service(() =>
          Promise.reject(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
        ),
      ),
      baseBody,
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Dependency Unavailable', status: 503 });
  });

  it('returns 500 instead of a contract-invalid 200 response', async () => {
    const invalid: ProductCheckResult = {
      result: 'potential_match',
      message: 'ok',
      checkedCampaignVersion: 0,
    };
    const response = await postCheck(appWith(service(() => Promise.resolve(invalid))), baseBody);

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    await expect(response.json()).resolves.toMatchObject({
      title: 'Internal Server Error',
      status: 500,
    });
  });
});
