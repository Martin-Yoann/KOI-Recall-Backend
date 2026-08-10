import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { ProductCheckResponse } from '../src/contracts/toc.js';
import type { ProductCheckService } from '../src/modules/product-checks/service.js';
import type { IdentificationResult } from '../src/modules/product-identification/policy.js';

const baseBody = {
  mode: 'product_identifiers',
  identifiers: [{ type: 'unit_upc', value: '0123456789012' }],
};

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

function matchResult(overrides: Partial<IdentificationResult> = {}): IdentificationResult {
  return {
    result: 'potential_match',
    reasonCodes: ['identifier.single_match'],
    matchedVariantIds: ['a1b2c3d4-0000-4000-8000-000000000001'],
    requiredEvidenceProfile: 'identifier_match',
    checkedCampaignVersion: 1,
    ...overrides,
  };
}

describe('POST /v1/recall-campaigns/{slug}/product-checks', () => {
  it('returns 200 with a potential match and stable reason codes', async () => {
    const result = matchResult();
    const response = await postCheck(appWith(service(() => Promise.resolve(result))), baseBody);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ProductCheckResponse;
    expect(body).toMatchObject({
      result: 'potential_match',
      reasonCodes: ['identifier.single_match'],
      matchedVariantIds: ['a1b2c3d4-0000-4000-8000-000000000001'],
      identificationMode: 'product_identifiers',
      messageKey: 'product_check.potential_match',
      checkedCampaignVersion: 1,
      disclaimer: 'This check is preliminary and is not a final eligibility decision.',
    });
    expect(body).not.toHaveProperty('message'); // M2: no hardcoded message
  });

  it('maps an ambiguous multi-match to manual_review messageKey', async () => {
    const result = matchResult({
      result: 'manual_review',
      reasonCodes: ['identifier.ambiguous_multi_match'],
      matchedVariantIds: [
        'a1b2c3d4-0000-4000-8000-000000000001',
        'a1b2c3d4-0000-4000-8000-000000000002',
      ],
      requiredEvidenceProfile: 'manual_review',
    });
    const response = await postCheck(appWith(service(() => Promise.resolve(result))), baseBody);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ProductCheckResponse;
    expect(body.messageKey).toBe('product_check.manual_review.ambiguous');
  });

  it('accepts a purchase_evidence request and returns corroboration (V1.1)', async () => {
    const result = matchResult({
      result: 'manual_review',
      reasonCodes: ['input.insufficient_signals', 'purchase_evidence.verified'],
      matchedVariantIds: [],
      requiredEvidenceProfile: 'manual_review',
      purchaseCorroboration: 'verified',
    });
    const response = await postCheck(appWith(service(() => Promise.resolve(result))), {
      mode: 'purchase_evidence',
      purchaseEvidence: {
        orderNumber: 'ORD-123',
        amountPaidMinor: 1990,
        currency: 'USD',
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ProductCheckResponse;
    expect(body.identificationMode).toBe('purchase_evidence');
    expect(body.purchaseCorroboration).toBe('verified');
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

  it('rejects a payload whose mode conflicts with the discriminated union', async () => {
    const response = await postCheck(appWith(service(() => Promise.resolve(matchResult()))), {
      mode: 'product_identifiers',
      identifiers: [],
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
  });
});
