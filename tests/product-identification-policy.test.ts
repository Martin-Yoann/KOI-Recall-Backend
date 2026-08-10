import { describe, expect, it } from 'vitest';

import {
  identify,
  type CampaignSnapshot,
  type CampaignSnapshotVariant,
  REASON_CODES,
  RISK_FLAGS,
} from '../src/modules/product-identification/policy.js';

const PRODUCT_ID = '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5';
const VARIANT_A = 'a1b2c3d4-0000-4000-8000-000000000001';
const VARIANT_B = 'a1b2c3d4-0000-4000-8000-000000000002';

function variant(id: string, model: string, identifiers: CampaignSnapshotVariant['identifiers']) {
  return { id, productId: PRODUCT_ID, model, identifiers };
}

const upcIdentifier = (value: string) => ({
  variantId: VARIANT_A,
  type: 'unit_upc' as const,
  normalizedValue: value,
});

/** Two variants sharing the same UPC — the JSM-18A / JSM-18D ambiguity. */
function ambiguousSnapshot(): CampaignSnapshot {
  return {
    campaignId: 'campaign-1',
    campaignSlug: 'music-lollipop-demo-2026',
    versionNumber: 1,
    products: [
      {
        id: PRODUCT_ID,
        attributes: { flavors: ['Peach'], shapes: ['Bear'] },
        variants: [
          variant(VARIANT_A, 'JSM-18A', [upcIdentifier('0123456789012')]),
          variant(VARIANT_B, 'JSM-18D', [upcIdentifier('0123456789012')]),
        ],
      },
    ],
    lots: [],
  };
}

function simpleSnapshot(): CampaignSnapshot {
  return {
    campaignId: 'campaign-1',
    campaignSlug: 'music-lollipop-demo-2026',
    versionNumber: 2,
    products: [
      {
        id: PRODUCT_ID,
        attributes: { flavors: ['Peach'], shapes: ['Bear'] },
        variants: [variant(VARIANT_A, 'JSM-18A', [upcIdentifier('0123456789012')])],
      },
    ],
    lots: [],
  };
}

describe('ProductIdentificationPolicy.identify (ADR-0002)', () => {
  it('returns potential_match + single variant for a unique UPC hit', () => {
    const result = identify(
      {
        mode: 'product_identifiers',
        campaignSlug: 'music-lollipop-demo-2026',
        signals: { identifiers: ['0123456789012'] },
      },
      simpleSnapshot(),
    );

    expect(result.result).toBe('potential_match');
    expect(result.matchedVariantIds).toEqual([VARIANT_A]);
    expect(result.reasonCodes).toContain(REASON_CODES.IDENTIFIER_SINGLE_MATCH);
    expect(result.requiredEvidenceProfile).toBe('identifier_match');
    expect(result.checkedCampaignVersion).toBe(2);
  });

  it('returns manual_review when one UPC hits two variants (ambiguity)', () => {
    const result = identify(
      {
        mode: 'product_identifiers',
        campaignSlug: 'music-lollipop-demo-2026',
        signals: { identifiers: ['0123456789012'] },
      },
      ambiguousSnapshot(),
    );

    expect(result.result).toBe('manual_review');
    expect(result.matchedVariantIds).toHaveLength(2);
    expect(result.reasonCodes).toContain(REASON_CODES.IDENTIFIER_AMBIGUOUS_MULTI_MATCH);
  });

  it('returns not_matched for an unknown UPC', () => {
    const result = identify(
      {
        mode: 'product_identifiers',
        campaignSlug: 'music-lollipop-demo-2026',
        signals: { identifiers: ['9999999999999'] },
      },
      simpleSnapshot(),
    );

    expect(result.result).toBe('not_matched');
    expect(result.matchedVariantIds).toHaveLength(0);
    expect(result.reasonCodes).toContain(REASON_CODES.IDENTIFIER_NO_MATCH);
  });

  it('returns manual_review when no codes, receipt, or order info exist', () => {
    const result = identify(
      {
        mode: 'unknown',
        campaignSlug: 'music-lollipop-demo-2026',
        signals: { shape: 'Bear' },
      },
      simpleSnapshot(),
    );

    expect(result.result).toBe('manual_review');
    expect(result.reasonCodes).toContain(REASON_CODES.INPUT_INSUFFICIENT_SIGNALS);
  });

  it('matches the legacy shape/flavor/lot/date path during M1–M3 dual read', () => {
    const snapshot: CampaignSnapshot = {
      ...simpleSnapshot(),
      lots: [
        {
          productId: PRODUCT_ID,
          lotCode: 'ML-2406-A',
          dateCode: '06/2024',
          eligibilityStatus: 'affected',
        },
      ],
    };
    const result = identify(
      {
        mode: 'product_identifiers',
        campaignSlug: 'music-lollipop-demo-2026',
        signals: {
          shape: 'Bear',
          flavor: 'Peach',
          lotCode: 'ML-2406-A',
          dateCode: '06/2024',
        },
      },
      snapshot,
    );

    expect(result.result).toBe('potential_match');
    expect(result.matchedVariantIds).toContain(VARIANT_A);
  });

  it('never emits safe/safe-to-use wording', () => {
    const results = [
      identify(
        { mode: 'product_identifiers', campaignSlug: 'x', signals: { identifiers: ['nope'] } },
        simpleSnapshot(),
      ),
      identify({ mode: 'unknown', campaignSlug: 'x', signals: {} }, simpleSnapshot()),
    ];
    for (const result of results) {
      expect(JSON.stringify(result).toLowerCase()).not.toContain('safe');
    }
  });

  it('reports purchase corroboration independently of identity (V1.1)', () => {
    const result = identify(
      {
        mode: 'purchase_evidence',
        campaignSlug: 'music-lollipop-demo-2026',
        signals: {
          purchaseEvidence: {
            orderNumber: 'ORD-123',
            amountPaidMinor: 1990,
            currency: 'USD',
          },
        },
      },
      simpleSnapshot(),
    );

    // Corroboration is present even though no identifier matched.
    expect(result.purchaseCorroboration).toBe('verified');
    expect(result.reasonCodes).toContain(REASON_CODES.PURCHASE_EVIDENCE_VERIFIED);
  });

  it('flags evidence_insufficient instead of rejecting when order lacks amount', () => {
    const result = identify(
      {
        mode: 'purchase_evidence',
        campaignSlug: 'music-lollipop-demo-2026',
        signals: { purchaseEvidence: { orderNumber: 'ORD-456' } },
      },
      simpleSnapshot(),
    );

    expect(result.riskFlags).toContain(RISK_FLAGS.EVIDENCE_INSUFFICIENT);
    expect(result.result).toBe('manual_review'); // never silently rejected
  });
});
