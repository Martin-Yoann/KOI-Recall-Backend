import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import {
  campaignProductIdentifiers,
  campaignProductLots,
  campaignProductVariants,
  campaignProducts,
  recallCampaigns,
} from '../../db/schema/index.js';
import { buildPublishedVersionQuery } from '../campaigns/drizzle-campaign-service.js';
import type { CampaignSnapshot, CampaignSnapshotProduct } from './policy.js';

/**
 * Reads the versioned rule snapshot (ADR-0002 §2.2) that {@link identify}
 * evaluates against. Product Check reads the currently published version;
 * Claim Submission re-checks the same snapshot pinned to the draft's campaign
 * version so publish-time rules are honoured even after a later publication.
 */
export interface CampaignSnapshotReader {
  /** Reads the campaign's currently published version snapshot. Returns null when not visible. */
  readPublished(campaignSlug: string): Promise<CampaignSnapshot | null>;
  /** Reads the snapshot for a pinned campaign version (Claim re-check). */
  readPinned(campaignSlug: string, versionId: string): Promise<CampaignSnapshot | null>;
}

export class DrizzleCampaignSnapshotReader implements CampaignSnapshotReader {
  constructor(private readonly db: Database) {}

  async readPublished(campaignSlug: string): Promise<CampaignSnapshot | null> {
    const db = this.db;

    const [campaign] = await db
      .select({
        id: recallCampaigns.id,
        publishedVersionId: recallCampaigns.publishedVersionId,
      })
      .from(recallCampaigns)
      .where(and(eq(recallCampaigns.slug, campaignSlug), eq(recallCampaigns.status, 'active')))
      .limit(1);

    if (!campaign || !campaign.publishedVersionId) return null;
    const versionId = campaign.publishedVersionId;

    const [version] = await buildPublishedVersionQuery(db, campaign.id, versionId);
    if (!version) return null;

    return this.readSnapshot(campaign.id, campaignSlug, versionId, version.versionNumber);
  }

  async readPinned(campaignSlug: string, versionId: string): Promise<CampaignSnapshot | null> {
    const db = this.db;

    const [campaign] = await db
      .select({ id: recallCampaigns.id })
      .from(recallCampaigns)
      .where(eq(recallCampaigns.slug, campaignSlug))
      .limit(1);
    if (!campaign) return null;

    const [version] = await buildPublishedVersionQuery(db, campaign.id, versionId);
    if (!version) return null;

    return this.readSnapshot(campaign.id, campaignSlug, versionId, version.versionNumber);
  }

  private async readSnapshot(
    campaignId: string,
    campaignSlug: string,
    versionId: string,
    versionNumber: number,
  ): Promise<CampaignSnapshot> {
    const db = this.db;

    const products = await db
      .select({
        id: campaignProducts.id,
        attributes: campaignProducts.attributes,
      })
      .from(campaignProducts)
      .where(eq(campaignProducts.campaignVersionId, versionId));

    const productIds = products.map((product) => product.id);
    if (productIds.length === 0) {
      return { campaignId, campaignSlug, versionNumber, products: [], lots: [] };
    }

    const [variants, lots] = await Promise.all([
      db
        .select({
          id: campaignProductVariants.id,
          campaignProductId: campaignProductVariants.campaignProductId,
          model: campaignProductVariants.model,
        })
        .from(campaignProductVariants)
        .where(inArray(campaignProductVariants.campaignProductId, productIds)),
      db
        .select({
          productId: campaignProductLots.campaignProductId,
          lotCode: campaignProductLots.lotCode,
          dateCode: campaignProductLots.dateCode,
          eligibilityStatus: campaignProductLots.eligibilityStatus,
        })
        .from(campaignProductLots)
        .where(inArray(campaignProductLots.campaignProductId, productIds)),
    ]);

    const variantIds = variants.map((variant) => variant.id);
    const identifiers =
      variantIds.length > 0
        ? await db
            .select({
              variantId: campaignProductIdentifiers.variantId,
              type: campaignProductIdentifiers.identifierType,
              normalizedValue: campaignProductIdentifiers.normalizedValue,
            })
            .from(campaignProductIdentifiers)
            .where(inArray(campaignProductIdentifiers.variantId, variantIds))
        : [];

    const productById = new Map<string, CampaignSnapshotProduct>();
    for (const product of products) {
      productById.set(product.id, {
        id: product.id,
        attributes: product.attributes,
        variants: [],
      });
    }
    for (const variant of variants) {
      productById.get(variant.campaignProductId)?.variants.push({
        id: variant.id,
        productId: variant.campaignProductId,
        model: variant.model,
        identifiers: [],
      });
    }
    for (const identifier of identifiers) {
      for (const product of productById.values()) {
        const variant = product.variants.find((v) => v.id === identifier.variantId);
        if (variant) {
          variant.identifiers.push({
            variantId: identifier.variantId,
            type: identifier.type,
            normalizedValue: identifier.normalizedValue,
          });
        }
      }
    }

    return {
      campaignId,
      campaignSlug,
      versionNumber,
      products: [...productById.values()],
      lots,
    };
  }
}
