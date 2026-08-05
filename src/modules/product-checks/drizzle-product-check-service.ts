import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { campaignProductLots, campaignProducts, recallCampaigns } from '../../db/schema/index.js';
import { buildPublishedVersionQuery } from '../campaigns/drizzle-campaign-service.js';
import { evaluateProductCheck } from './matcher.js';
import type { ProductCheckInput, ProductCheckResult, ProductCheckService } from './service.js';

/**
 * Reads published campaign products and lots from Postgres via Drizzle to run a
 * preliminary affected-product check. The injected {@link Database} is the
 * dual-adapter union, so the same code runs against Neon HTTP in production and
 * node-postgres locally with no branching.
 */
export class DrizzleProductCheckService implements ProductCheckService {
  constructor(private readonly db: Database) {}

  async check(input: ProductCheckInput): Promise<ProductCheckResult | null> {
    const db = this.db;

    const [campaign] = await db
      .select({
        id: recallCampaigns.id,
        publishedVersionId: recallCampaigns.publishedVersionId,
      })
      .from(recallCampaigns)
      .where(
        and(eq(recallCampaigns.slug, input.campaignSlug), eq(recallCampaigns.status, 'active')),
      )
      .limit(1);

    if (!campaign || !campaign.publishedVersionId) return null;
    const versionId = campaign.publishedVersionId;

    const [version] = await buildPublishedVersionQuery(db, campaign.id, versionId);
    if (!version) return null;

    const products = await db
      .select({
        id: campaignProducts.id,
        attributes: campaignProducts.attributes,
      })
      .from(campaignProducts)
      .where(eq(campaignProducts.campaignVersionId, versionId));

    const productIds = products.map((product) => product.id);
    const lots =
      productIds.length > 0
        ? await db
            .select({
              campaignProductId: campaignProductLots.campaignProductId,
              lotCode: campaignProductLots.lotCode,
              dateCode: campaignProductLots.dateCode,
              eligibilityStatus: campaignProductLots.eligibilityStatus,
            })
            .from(campaignProductLots)
            .where(inArray(campaignProductLots.campaignProductId, productIds))
        : [];

    const evaluation = evaluateProductCheck(
      {
        shape: input.shape,
        flavor: input.flavor,
        lotCode: input.lotCode,
        dateCode: input.dateCode,
      },
      products,
      lots,
    );

    return {
      result: evaluation.result,
      message: evaluation.message,
      checkedCampaignVersion: version.versionNumber,
    };
  }
}
