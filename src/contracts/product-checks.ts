import { z } from '@hono/zod-openapi';

import { isoDate, uuid } from './common.js';

/**
 * A recognition signal the consumer supplies. Values are normalized for
 * matching by the Policy; `raw_value` is preserved for display/audit.
 */
export const productIdentifierSchema = z
  .object({
    type: z.enum(['sku', 'unit_upc', 'gtin14', 'model', 'style', 'lot_code', 'date_code']),
    value: z.string().trim().min(1).max(160),
  })
  .openapi('ProductIdentifier');

/**
 * Purchase trail (V1.1/O3.1): corroboration, NOT a product identifier. All
 * fields default to optional; the Evidence Profile decides what to require.
 */
export const purchaseEvidenceSchema = z
  .object({
    platform: z.enum(['amazon', 'tiktok', 'koi', 'retailer', 'gift', 'other']).optional(),
    sellerOrStore: z.string().trim().max(160).optional(),
    orderNumber: z.string().trim().max(120).optional(),
    purchaseDate: isoDate.optional(),
    lineItemTitle: z.string().trim().max(240).optional(),
    lineItemSku: z.string().trim().max(120).optional(),
    quantity: z.number().int().min(1).max(100).optional(),
    amountPaidMinor: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    receiptDocumentIds: z.array(uuid).max(10).optional(),
  })
  .openapi('PurchaseEvidence');

const productCheckIdentifiersInput = z
  .object({
    mode: z.literal('product_identifiers'),
    identifiers: z.array(productIdentifierSchema).min(1).max(20),
    purchaseEvidence: purchaseEvidenceSchema.optional(),
  })
  .openapi('ProductCheckIdentifiersInput');

const productCheckPurchaseEvidenceInput = z
  .object({
    mode: z.literal('purchase_evidence'),
    purchaseEvidence: purchaseEvidenceSchema,
  })
  .openapi('ProductCheckPurchaseEvidenceInput');

const productCheckUnknownInput = z
  .object({
    mode: z.literal('unknown'),
    purchaseEvidence: purchaseEvidenceSchema.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .openapi('ProductCheckUnknownInput');

/**
 * Legacy four-field intake (M1–M3 dual read): shape/flavor + lot/date codes.
 * Evaluated by the Policy's legacy matching path against flat product
 * attributes and affected-lot rows. At least one field is required so an empty
 * submission is rejected up-front rather than routing to a confusing review.
 */
const productCheckLegacyInput = z
  .object({
    mode: z.literal('legacy'),
    shape: z.string().trim().max(80).optional(),
    flavor: z.string().trim().max(80).optional(),
    lotCode: z.string().trim().max(80).optional(),
    dateCode: z.string().trim().max(40).optional(),
  })
  .superRefine((value, context) => {
    if (!value.shape && !value.flavor && !value.lotCode && !value.dateCode) {
      context.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'At least one of shape, flavor, lotCode, or dateCode is required.',
      });
    }
  })
  .openapi('ProductCheckLegacyInput');

/**
 * Product-check request as a discriminated union of the intake modes
 * (ADR-0002 §2.1, M2). Product identity and purchase evidence are kept
 * separate so corroboration is never mistaken for an identifier. The legacy
 * four-field path is retained through M3 for the shape/flavor + lot/date UI.
 */
export const productCheckRequestSchema = z
  .discriminatedUnion('mode', [
    productCheckIdentifiersInput,
    productCheckPurchaseEvidenceInput,
    productCheckUnknownInput,
    productCheckLegacyInput,
  ])
  .openapi('ProductCheckRequest');

export type ProductCheckRequest = z.infer<typeof productCheckRequestSchema>;

const productCheckResponseObject = z.object({
  result: z.enum(['potential_match', 'not_matched', 'manual_review']),
  reasonCodes: z.array(z.string().min(1).max(80)),
  matchedVariantIds: z.array(uuid),
  identificationMode: z.enum(['product_identifiers', 'purchase_evidence', 'unknown', 'legacy']),
  messageKey: z.enum([
    'product_check.potential_match',
    'product_check.manual_review.ambiguous',
    'product_check.manual_review.insufficient_signals',
    'product_check.not_matched',
  ]),
  purchaseCorroboration: z.enum(['verified', 'partial', 'not_provided', 'conflict']).optional(),
  riskFlags: z.array(z.string().min(1).max(80)).optional(),
  checkedCampaignVersion: z.number().int().positive(),
  disclaimer: z.literal('This check is preliminary and is not a final eligibility decision.'),
});

export const productCheckResponseSchema = productCheckResponseObject
  .superRefine((value: z.infer<typeof productCheckResponseObject>, context: z.RefinementCtx) => {
    // ADR-0002 §2.1: multi-candidate ambiguity must surface as manual_review.
    if (value.matchedVariantIds.length > 1 && value.result !== 'manual_review') {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'result must be manual_review when matchedVariantIds.length > 1.',
      });
    }
    if (value.result === 'not_matched' && value.matchedVariantIds.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['matchedVariantIds'],
        message: 'not_matched must not include matched variants.',
      });
    }
  })
  .openapi('ProductCheckResponse');

/**
 * The preliminary product-check result returned to consumers. Derived from the
 * Zod contract so the service and route handler share one shape.
 */
export type ProductCheckResponse = z.infer<typeof productCheckResponseSchema>;
