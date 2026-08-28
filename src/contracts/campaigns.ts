import { z } from '@hono/zod-openapi';

import { uuid, isoDateTime } from './common.js';

export const evidenceRequirementSchema = z
  .object({
    category: z.enum(['product_photo', 'proof_of_purchase', 'incident_evidence']),
    required: z.boolean(),
    minimumFiles: z.number().int().min(0),
    maximumFiles: z.number().int().min(1),
    allowedMimeTypes: z.array(z.string()),
    maximumFileSizeBytes: z.number().int().positive(),
    instructions: z.string(),
  })
  .openapi('EvidenceRequirement');

export const publicProductSchema = z
  .object({
    productId: uuid,
    sku: z.string().openapi({
      description:
        'Internal catalogue SKU. Deliberately NOT a UPC — unit UPCs are exposed via `upcs`.',
    }),
    /** Unit UPCs from curated product identifiers (ADR-0001); may repeat across variants. */
    upcs: z.array(z.string()),
    brand: z.string(),
    name: z.string(),
    flavors: z.array(z.string()),
    shapes: z.array(z.string()),
    affectedLots: z.array(
      z.object({
        lotCode: z.string(),
        dateCode: z.string(),
        attributes: z.record(z.string(), z.unknown()),
      }),
    ),
  })
  .openapi('PublicCampaignProduct');

export const campaignResponseSchema = z
  .object({
    campaign: z.object({
      slug: z.string(),
      code: z.string(),
      version: z.number().int().positive(),
      publishedAt: isoDateTime.nullable().openapi({
        description:
          'When the published campaign version was announced; null for legacy versions predating the field.',
      }),
      locale: z.string(),
      defaultLocale: z.string(),
      privacyNotice: z.object({ version: z.string().max(80), url: z.string().url() }),
      title: z.string(),
      summary: z.string(),
      hazard: z.string(),
      immediateAction: z.string(),
      remedySummary: z.string(),
      support: z.object({ email: z.string().email(), phone: z.string(), hours: z.string() }),
      products: z.array(publicProductSchema),
      remedies: z.array(z.object({ code: z.string(), displayName: z.string() })),
      evidenceRequirements: z.array(evidenceRequirementSchema),
    }),
  })
  .openapi('CampaignResponse');

/**
 * The public campaign object carried by CampaignResponse. Derived from the Zod
 * contract so the service, mapper, and route handler all share one shape.
 */
export type CampaignView = z.infer<typeof campaignResponseSchema>['campaign'];
