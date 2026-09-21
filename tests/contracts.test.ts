import { describe, expect, it } from 'vitest';

import { claimSubmissionRequestSchema } from '../src/contracts/toc.js';
import type { ZodIssue } from 'zod';

const baseClaim = {
  draftId: '21326c9a-5dc2-430f-98a6-546729a1065f',
  draftToken: 'one-time-secret-with-at-least-32-characters',
  locale: 'en-US' as const,
  consumer: {
    firstName: 'Taylor',
    lastName: 'Example',
    email: 'taylor@example.com',
    currentDeliveryAddress: {
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
      identificationMode: 'product_identifiers' as const,
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
      expect(result.error.issues.map((issue: ZodIssue) => issue.path.join('.'))).toEqual(
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

describe('structured incident fields (P0-4)', () => {
  // Stage 1 of the rollout: the new fields are accepted but optional, so a
  // payload that omits every one of them must still validate.
  it('accepts a confirmed incident without the new structured fields', () => {
    const result = claimSubmissionRequestSchema.safeParse({
      ...baseClaim,
      incidentAnswer: 'yes',
      incidentDetails: {
        eventTypes: ['other'],
        narrative: 'A fictional hazard was observed but no injury occurred.',
        occurredDateUnknown: true,
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts the full structured set', () => {
    const result = claimSubmissionRequestSchema.safeParse({
      ...baseClaim,
      incidentAnswer: 'yes',
      incidentDetails: {
        eventTypes: ['injury', 'choking'],
        narrative: 'A fictional choking incident occurred during use.',
        occurredDateUnknown: true,
        injurySeverity: 'medical_attention',
        medicalTreatment: 'emergency',
        usedAsIntended: 'no',
        failureMode: 'body_rupture',
        injuryDescription: 'A fictional description of the reported injury.',
        medicalTreatmentReceived: 'yes',
        unitType: 'original',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown failure mode rather than storing free text', () => {
    const result = claimSubmissionRequestSchema.safeParse({
      ...baseClaim,
      incidentAnswer: 'yes',
      incidentDetails: {
        eventTypes: ['other'],
        narrative: 'A fictional hazard was observed but no injury occurred.',
        occurredDateUnknown: true,
        failureMode: 'battery_exploded_spontaneously',
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue: ZodIssue) => issue.path.join('.'))).toContain(
        'incidentDetails.failureMode',
      );
    }
  });

  // The contradiction is rejected in every release stage: the strict switch
  // governs required fields, never self-contradictory ones.
  it('rejects "no treatment received" alongside a named treatment', () => {
    const result = claimSubmissionRequestSchema.safeParse({
      ...baseClaim,
      incidentAnswer: 'yes',
      incidentDetails: {
        eventTypes: ['injury'],
        narrative: 'A fictional minor injury occurred during use.',
        occurredDateUnknown: true,
        injurySeverity: 'minor',
        medicalTreatment: 'emergency',
        medicalTreatmentReceived: 'no',
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue: ZodIssue) => issue.path.join('.'))).toContain(
        'incidentDetails.medicalTreatmentReceived',
      );
    }
  });

  it('allows "no treatment received" when no treatment is named', () => {
    const result = claimSubmissionRequestSchema.safeParse({
      ...baseClaim,
      incidentAnswer: 'yes',
      incidentDetails: {
        eventTypes: ['injury'],
        narrative: 'A fictional minor injury occurred during use.',
        occurredDateUnknown: true,
        injurySeverity: 'minor',
        medicalTreatment: 'none',
        medicalTreatmentReceived: 'no',
      },
    });

    expect(result.success).toBe(true);
  });

  // New fields must not open a hole in the existing `no` rejection.
  it('still rejects an explicit no carrying structured incident fields', () => {
    const result = claimSubmissionRequestSchema.safeParse({
      ...baseClaim,
      incidentAnswer: 'no',
      incidentDetails: {
        narrative: 'No incident is reported.',
        occurredDateUnknown: true,
        failureMode: 'battery_exposure',
        injuryDescription: 'Should never be accepted for a no.',
        unitType: 'original',
      },
    });

    expect(result.success).toBe(false);
  });
});
