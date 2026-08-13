import { z } from '@hono/zod-openapi';

import { addressSchema, isoDate, isoDateTime, uuid } from './common.js';
import { productIdentifierSchema, purchaseEvidenceSchema } from './product-checks.js';

/**
 * A claimed product (M3 / T4.1): the legacy four fields are now optional
 * recognition signals, order fields live under purchaseEvidence (corroboration,
 * never an identifier), and identificationMode says which intake path ran.
 */
export const claimedProductSchema = z
  .object({
    campaignProductId: uuid,
    quantity: z.number().int().min(1).max(100),
    shape: z.string().max(80).optional(),
    flavor: z.string().max(80).optional(),
    lotCode: z.string().max(80).optional(),
    dateCode: z.string().max(40).optional(),
    identifiers: z.array(productIdentifierSchema).max(20).optional(),
    purchaseEvidence: purchaseEvidenceSchema.optional(),
    identificationMode: z.enum(['product_identifiers', 'purchase_evidence', 'unknown']),
    purchaseChannel: z.enum(['amazon', 'tiktok', 'koi', 'retailer', 'gift', 'other']),
    purchaseDate: isoDate.optional(),
    orderNumber: z.string().max(120).optional(),
  })
  .openapi('ClaimedProductInput');

const incidentEventTypeSchema = z.enum([
  'injury',
  'illness',
  'choking',
  'ingestion',
  'fire',
  'overheating',
  'property_damage',
  'near_miss',
  'other',
  'unknown',
]);

export const incidentDetailsSchema = z
  .object({
    eventTypes: z.array(incidentEventTypeSchema).min(1).optional(),
    narrative: z.string().trim().min(10).max(4000),
    occurredDate: isoDate.optional(),
    occurredDateUnknown: z.boolean().default(false),
    injurySeverity: z
      .enum(['none', 'minor', 'medical_attention', 'hospitalized', 'death', 'unknown'])
      .optional(),
    medicalTreatment: z
      .enum(['none', 'first_aid', 'outpatient', 'emergency', 'hospitalized', 'unknown'])
      .optional(),
    usedAsIntended: z.enum(['yes', 'no', 'unknown']).optional(),
  })
  .openapi('IncidentDetailsInput');

const claimSubmissionRequestObject = z
  .object({
    draftId: uuid,
    draftToken: z.string().min(32),
    locale: z.literal('en-US'),
    consumer: z.object({
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().min(1).max(100),
      email: z.string().email().max(254),
      phone: z.string().max(40).optional(),
      // M3/T4.1: current delivery address for Replacement fulfilment, optional
      // at the contract layer — the service enforces it per Remedy (D4/D8).
      // The original order address lives inside purchaseEvidence and is never
      // auto-copied here.
      currentDeliveryAddress: addressSchema.optional(),
    }),
    products: z.array(claimedProductSchema).min(1).max(20),
    remedyCode: z.string().min(1).max(60),
    documentIds: z.array(uuid).max(20),
    consents: z
      .array(
        z.object({
          type: z.enum(['privacy_notice', 'information_accuracy']),
          textVersion: z.string().min(1).max(80),
          accepted: z.literal(true),
        }),
      )
      .min(2),
    incidentAnswer: z.enum(['no', 'yes', 'unsure']),
    incidentDetails: incidentDetailsSchema.optional(),
  });

export const claimSubmissionRequestSchema = claimSubmissionRequestObject
  .superRefine((value: z.infer<typeof claimSubmissionRequestObject>, context: z.RefinementCtx) => {
    if (value.incidentAnswer === 'no' && value.incidentDetails) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails'],
        message: 'incidentDetails must be omitted when incidentAnswer is no.',
      });
    }

    if (value.incidentAnswer !== 'no' && !value.incidentDetails) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails'],
        message: 'incidentDetails is required when incidentAnswer is yes or unsure.',
      });
      return;
    }

    const details = value.incidentDetails;
    if (!details) return;

    if (value.incidentAnswer === 'yes' && !details.eventTypes?.length) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails', 'eventTypes'],
        message: 'eventTypes is required when incidentAnswer is yes.',
      });
    }

    if (value.incidentAnswer === 'yes' && !details.occurredDate && !details.occurredDateUnknown) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails', 'occurredDate'],
        message: 'Provide occurredDate or set occurredDateUnknown to true.',
      });
    }

    const hasInjury =
      details.eventTypes?.some(
        (type: z.infer<typeof incidentEventTypeSchema>) => type === 'injury' || type === 'illness',
      ) ?? false;
    if (hasInjury && !details.injurySeverity) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails', 'injurySeverity'],
        message: 'injurySeverity is required for injury or illness events.',
      });
    }
    if (hasInjury && !details.medicalTreatment) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails', 'medicalTreatment'],
        message: 'medicalTreatment is required for injury or illness events.',
      });
    }
  })
  .openapi('ClaimSubmissionRequest');

export type ClaimSubmissionRequest = z.infer<typeof claimSubmissionRequestSchema>;

export const claimSubmissionResponseSchema = z
  .object({
    caseReference: z.string().regex(/^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$/),
    submittedAt: isoDateTime,
    emailStatus: z.literal('queued'),
    nextStep: z.string(),
  })
  .openapi('ClaimSubmissionResponse');

export type ClaimSubmissionResponse = z.infer<typeof claimSubmissionResponseSchema>;

export const idempotencyHeaderSchema = z.object({
  'Idempotency-Key': z
    .string()
    .min(16)
    .max(128)
    .openapi({
      param: { name: 'Idempotency-Key', in: 'header' },
    }),
});
