import { describe, expect, it } from 'vitest';

import { deriveCorroboration, deriveRiskFlags } from '../src/modules/cases/drizzle-case-service.js';
import type { ClaimSubmissionRequest } from '../src/contracts/toc.js';

type ClaimedProduct = ClaimSubmissionRequest['products'][number];

function product(purchaseEvidence: ClaimedProduct['purchaseEvidence']): ClaimedProduct {
  return {
    campaignProductId: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
    quantity: 1,
    identificationMode: 'purchase_evidence',
    purchaseChannel: 'amazon',
    purchaseEvidence,
  };
}

describe('purchase corroboration and risk flags (O3.1/T4.4)', () => {
  it('remains partial without an authoritative order-index match', () => {
    const p = product({ orderNumber: 'ORD-1', amountPaidMinor: 1990, currency: 'USD' });
    expect(deriveCorroboration(p)).toBe('partial');
    expect(deriveRiskFlags(p)).toBeNull();
  });

  it('is partial when only an order number is present', () => {
    const p = product({ orderNumber: 'ORD-2' });
    expect(deriveCorroboration(p)).toBe('partial');
    expect(deriveRiskFlags(p)).toEqual(['evidence_insufficient']);
  });

  it('is partial when only a receipt document is present', () => {
    const p = product({ receiptDocumentIds: ['a996d56a-da5e-49c3-bf76-665130bbb88a'] });
    expect(deriveCorroboration(p)).toBe('partial');
    expect(deriveRiskFlags(p)).toBeNull();
  });

  it('is not_provided when no purchase evidence is supplied', () => {
    const p = product(undefined);
    expect(deriveCorroboration(p)).toBe('not_provided');
    expect(deriveRiskFlags(p)).toBeNull();
  });

  it('flags evidence_insufficient when an order lacks amount and receipt', () => {
    const p = product({ orderNumber: 'ORD-3', platform: 'tiktok' });
    expect(deriveCorroboration(p)).toBe('partial');
    expect(deriveRiskFlags(p)).toEqual(['evidence_insufficient']);
  });
});
