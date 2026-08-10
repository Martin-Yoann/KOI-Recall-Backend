import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { CampaignView } from '../src/contracts/toc.js';
import type { CampaignService } from '../src/modules/campaigns/service.js';

const campaign: CampaignView = {
  slug: 'music-lollipop-demo-2026',
  code: 'ML-DEMO-2026',
  version: 1,
  locale: 'en-US',
  defaultLocale: 'en-US',
  title: 'Music Lollipop Safety Recall',
  summary: 'Fictional test content.',
  hazard: 'Fictional hazard.',
  immediateAction: 'Stop using the product.',
  remedySummary: 'Replacement or refund.',
  support: {
    email: 'demo-support@example.invalid',
    phone: '(555) 010-2042',
    hours: 'Mon-Fri 9-5 ET',
  },
  products: [
    {
      productId: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
      sku: 'MUSIC-LOLLIPOP-DEMO-18G',
      brand: 'Candy Master',
      name: 'Music Lollipop',
      flavors: ['Peach'],
      shapes: ['Bear'],
      affectedLots: [{ lotCode: 'ML-2406-A', dateCode: '06/2024', attributes: {} }],
    },
  ],
  remedies: [{ code: 'replacement', displayName: 'Replacement' }],
  evidenceRequirements: [
    {
      category: 'product_photo',
      required: true,
      minimumFiles: 1,
      maximumFiles: 5,
      allowedMimeTypes: ['image/jpeg'],
      maximumFileSizeBytes: 10_485_760,
      instructions: 'Upload a clear photo.',
    },
  ],
};

function appWith(campaigns: CampaignService) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: { ...base.services, campaigns },
    platform: base.platform,
  };
  return createApp({
    config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    registry,
  });
}

/** A CampaignService mock that keeps publishVersion inert for read-only route tests. */
function mockCampaignService(
  getPublishedCampaign: CampaignService['getPublishedCampaign'],
): CampaignService {
  return {
    getPublishedCampaign,
    publishVersion: () =>
      Promise.resolve({ versionNumber: 1, publishedAt: new Date().toISOString() }),
  };
}

describe('GET /v1/recall-campaigns/{slug}', () => {
  it('returns 200 with a version-derived ETag and Content-Language when found', async () => {
    const service = mockCampaignService(() => Promise.resolve(campaign));
    const response = await appWith(service).request(
      '/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US',
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe('"v1:en-US"');
    expect(response.headers.get('Content-Language')).toBe('en-US');
    const body = (await response.json()) as { campaign: CampaignView };
    expect(body.campaign.slug).toBe('music-lollipop-demo-2026');
    expect(body.campaign.products[0]!.affectedLots[0]!.lotCode).toBe('ML-2406-A');
  });

  it('returns a 404 problem when the campaign is not found', async () => {
    const service = mockCampaignService(() => Promise.resolve(null));
    const response = await appWith(service).request(
      '/v1/recall-campaigns/missing-slug?locale=en-US',
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Not Found', status: 404 });
  });

  it('returns 503 when the database connection fails', async () => {
    const service = mockCampaignService(() =>
      Promise.reject(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
    );
    const response = await appWith(service).request(
      '/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US',
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Dependency Unavailable', status: 503 });
  });

  it('returns 500 instead of a contract-invalid 200 response', async () => {
    const invalidCampaign: CampaignView = {
      ...campaign,
      support: { ...campaign.support, email: 'not-an-email' },
      evidenceRequirements: [
        { ...campaign.evidenceRequirements[0]!, minimumFiles: 0, maximumFiles: 0 },
      ],
    };
    const service = mockCampaignService(() => Promise.resolve(invalidCampaign));

    const response = await appWith(service).request(
      '/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US',
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    await expect(response.json()).resolves.toMatchObject({
      title: 'Internal Server Error',
      status: 500,
    });
  });
});
