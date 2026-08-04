import { describe, expect, it } from 'vitest';

import { claimSubmissionRequestSchema } from '../src/contracts/toc.js';

const baseClaim = {
  draftId: '21326c9a-5dc2-430f-98a6-546729a1065f',
  draftToken: 'one-time-secret-with-at-least-32-characters',
  locale: 'en-US' as const,
  consumer: {
    firstName: 'Taylor',
    lastName: 'Example',
    email: 'taylor@example.com',
    mailingAddress: {
      line1: '100 Example Street',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      countryCode: 'US',
    },
  },
  products: [
    {
      campaignProductId: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
      quantity: 1,
      shape: 'Bear',
      flavor: 'Peach',
      lotCode: 'ML-2406-A',
      dateCode: '06/2024',
      purchaseChannel: 'amazon' as const,
    },
  ],
  remedyCode: 'replacement',
  documentIds: ['a996d56a-da5e-49c3-bf76-665130bbb88a', 'de0d8447-2889-4500-89bc-e81a27d17de5'],
  consents: [
    { type: 'privacy_notice' as const, textVersion: '2026-08-04', accepted: true as const },
    {
      type: 'information_accuracy' as const,
      textVersion: '2026-08-04',
      accepted: true as const,
    },
  ],
};

describe('claim incident contract', () => {
  it('accepts an explicit no without incident details', () => {
    expect(
      claimSubmissionRequestSchema.safeParse({ ...baseClaim, incidentAnswer: 'no' }),
    ).toMatchObject({ success: true });
  });

  it('rejects incident details when the answer is no', () => {
    const result = claimSubmissionRequestSchema.safeParse({
      ...baseClaim,
      incidentAnswer: 'no',
      incidentDetails: {
        eventTypes: ['near_miss'],
        narrative: 'A fictional near miss occurred.',
        occurredDateUnknown: true,
      },
    });

    expect(result.success).toBe(false);
  });

  it.each(['yes', 'unsure'] as const)('requires details for %s', (incidentAnswer) => {
    const result = claimSubmissionRequestSchema.safeParse({ ...baseClaim, incidentAnswer });

    expect(result.success).toBe(false);
  });

  it('accepts unsure with only a factual narrative', () => {
    const result = claimSubmissionRequestSchema.safeParse({
      ...baseClaim,
      incidentAnswer: 'unsure',
      incidentDetails: {
        narrative: 'The consumer is unsure whether a safety incident occurred.',
      },
    });

    expect(result.success).toBe(true);
  });

  it('requires severity and treatment for injury or illness', () => {
    const result = claimSubmissionRequestSchema.safeParse({
      ...baseClaim,
      incidentAnswer: 'yes',
      incidentDetails: {
        eventTypes: ['injury'],
        narrative: 'A fictional minor injury occurred during use.',
        occurredDateUnknown: true,
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining([
          'incidentDetails.injurySeverity',
          'incidentDetails.medicalTreatment',
        ]),
      );
    }
  });

  it('accepts a complete injury report with an unknown date', () => {
    const result = claimSubmissionRequestSchema.safeParse({
      ...baseClaim,
      incidentAnswer: 'yes',
      incidentDetails: {
        eventTypes: ['injury'],
        narrative: 'A fictional minor injury occurred during use.',
        occurredDateUnknown: true,
        injurySeverity: 'minor',
        medicalTreatment: 'first_aid',
        usedAsIntended: 'yes',
      },
    });

    expect(result.success).toBe(true);
  });
});
