import { describe, expect, it } from 'vitest';

import { mapToCampaignView, type CampaignSource } from '../src/modules/campaigns/mapper.js';
import type { CampaignView } from '../src/contracts/campaigns.js';

const baseSource: CampaignSource = {
  campaign: {
    slug: 'music-lollipop-demo-2026',
    code: 'ML-DEMO-2026',
    defaultLocale: 'en-US',
    versionNumber: 1,
  },
  localization: {
    locale: 'en-US',
    title: 'Music Lollipop Safety Recall',
    summary: 'summary',
    hazard: 'hazard',
    immediateAction: 'stop using',
    remedySummary: 'replacement or refund',
    supportEmail: 'demo-support@example.invalid',
    supportPhone: '(555) 010-2042',
    supportHours: 'Mon-Fri 9-5 ET',
  },
  products: [
    {
      id: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
      sku: 'MUSIC-LOLLIPOP-DEMO-18G',
      brand: 'Candy Master',
      name: 'Music Lollipop',
      attributes: { flavors: ['Peach', 'Strawberry'], shapes: ['Bear', 'Dinosaur'] },
      sortOrder: 2,
    },
    {
      id: '00000000-0000-4000-8000-000000000001',
      sku: 'OTHER-SKU',
      brand: 'Candy Master',
      name: 'Other',
      attributes: { flavors: 'not-an-array', shapes: undefined },
      sortOrder: 1,
    },
  ],
  lots: [
    {
      campaignProductId: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
      lotCode: 'ML-2408-C',
      dateCode: '08/2024',
      eligibilityStatus: 'affected',
      attributes: { batch: 'c' },
    },
    {
      campaignProductId: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
      lotCode: 'ML-2406-A',
      dateCode: '06/2024',
      eligibilityStatus: 'affected',
      attributes: {},
    },
    {
      campaignProductId: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
      lotCode: 'ML-9999-Z',
      dateCode: '12/2024',
      eligibilityStatus: 'not_affected',
      attributes: {},
    },
  ],
  remedies: [
    { code: 'refund', displayName: 'Refund', active: true, sortOrder: 2 },
    { code: 'replacement', displayName: 'Replacement', active: true, sortOrder: 1 },
    { code: 'retired', displayName: 'Retired', active: false, sortOrder: 0 },
  ],
  evidence: [
    {
      category: 'proof_of_purchase',
      required: true,
      minimumFiles: 1,
      maximumFiles: 3,
      allowedMimeTypes: ['application/pdf'],
      maximumFileSizeBytes: 10_485_760,
      instructions: 'receipt',
    },
    {
      category: 'product_photo',
      required: true,
      minimumFiles: 1,
      maximumFiles: 5,
      allowedMimeTypes: ['image/jpeg'],
      maximumFileSizeBytes: 10_485_760,
      instructions: 'photo',
    },
  ],
};

describe('campaign mapper', () => {
  const view = mapToCampaignView(baseSource);

  it('maps campaign, version and localization into the public view', () => {
    expect(view.slug).toBe('music-lollipop-demo-2026');
    expect(view.code).toBe('ML-DEMO-2026');
    expect(view.version).toBe(1);
    expect(view.locale).toBe('en-US');
    expect(view.support).toEqual({
      email: 'demo-support@example.invalid',
      phone: '(555) 010-2042',
      hours: 'Mon-Fri 9-5 ET',
    });
  });

  it('orders products by sort order and reads flavors/shapes from attributes', () => {
    expect(view.products.map((product: CampaignView['products'][number]) => product.sku)).toEqual([
      'OTHER-SKU',
      'MUSIC-LOLLIPOP-DEMO-18G',
    ]);
    const lollipop = view.products[1]!;
    expect(lollipop.flavors).toEqual(['Peach', 'Strawberry']);
    expect(lollipop.shapes).toEqual(['Bear', 'Dinosaur']);
    expect(view.products[0]!.flavors).toEqual([]);
    expect(view.products[0]!.shapes).toEqual([]);
  });

  it('keeps only affected lots, ordered by lot then date code', () => {
    const affected = view.products[1]!.affectedLots;
    expect(affected).toEqual([
      { lotCode: 'ML-2406-A', dateCode: '06/2024', attributes: {} },
      { lotCode: 'ML-2408-C', dateCode: '08/2024', attributes: { batch: 'c' } },
    ]);
  });

  it('keeps only active remedies, ordered by sort order', () => {
    expect(view.remedies).toEqual([
      { code: 'replacement', displayName: 'Replacement' },
      { code: 'refund', displayName: 'Refund' },
    ]);
  });

  it('orders evidence requirements by category', () => {
    expect(view.evidenceRequirements.map((evidence: CampaignView['evidenceRequirements'][number]) => evidence.category)).toEqual([
      'product_photo',
      'proof_of_purchase',
    ]);
  });
});
