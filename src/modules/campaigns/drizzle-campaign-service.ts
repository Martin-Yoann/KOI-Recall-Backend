import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import {
  campaignEvidenceRequirements,
  campaignLocalizations,
  campaignProductLots,
  campaignProducts,
  campaignRemedyOptions,
  campaignVersions,
  recallCampaigns,
} from '../../db/schema/index.js';
import type { CampaignView } from '../../contracts/toc.js';
import type { CampaignService, PublishedCampaignQuery } from './service.js';
import { mapToCampaignView } from './mapper.js';

export function buildPublishedVersionQuery(db: Database, campaignId: string, versionId: string) {
  return db
    .select({ versionNumber: campaignVersions.versionNumber })
    .from(campaignVersions)
    .where(
      and(
        eq(campaignVersions.id, versionId),
        eq(campaignVersions.campaignId, campaignId),
        eq(campaignVersions.status, 'published'),
      ),
    )
    .limit(1);
}

/**
 * Reads published campaigns from Postgres via Drizzle. The injected {@link Database}
 * is the dual-adapter union, so the same code runs against Neon HTTP in production
 * and node-postgres locally with no branching.
 */
export class DrizzleCampaignService implements CampaignService {
  constructor(private readonly db: Database) {}

  async getPublishedCampaign(query: PublishedCampaignQuery): Promise<CampaignView | null> {
    const db = this.db;

    const [campaign] = await db
      .select({
        id: recallCampaigns.id,
        slug: recallCampaigns.slug,
        code: recallCampaigns.code,
        defaultLocale: recallCampaigns.defaultLocale,
        publishedVersionId: recallCampaigns.publishedVersionId,
      })
      .from(recallCampaigns)
      .where(and(eq(recallCampaigns.slug, query.slug), eq(recallCampaigns.status, 'active')))
      .limit(1);

    if (!campaign || !campaign.publishedVersionId) return null;
    const versionId = campaign.publishedVersionId;

    const [version] = await buildPublishedVersionQuery(db, campaign.id, versionId);
    if (!version) return null;

    const [localization] = await db
      .select({
        locale: campaignLocalizations.locale,
        title: campaignLocalizations.title,
        summary: campaignLocalizations.summary,
        hazard: campaignLocalizations.hazard,
        immediateAction: campaignLocalizations.immediateAction,
        remedySummary: campaignLocalizations.remedySummary,
        supportEmail: campaignLocalizations.supportEmail,
        supportPhone: campaignLocalizations.supportPhone,
        supportHours: campaignLocalizations.supportHours,
      })
      .from(campaignLocalizations)
      .where(
        and(
          eq(campaignLocalizations.campaignVersionId, versionId),
          eq(campaignLocalizations.locale, query.locale),
        ),
      )
      .limit(1);
    if (!localization) return null;

    const products = await db
      .select({
        id: campaignProducts.id,
        sku: campaignProducts.sku,
        brand: campaignProducts.brand,
        name: campaignProducts.name,
        attributes: campaignProducts.attributes,
        sortOrder: campaignProducts.sortOrder,
      })
      .from(campaignProducts)
      .where(eq(campaignProducts.campaignVersionId, versionId))
      .orderBy(campaignProducts.sortOrder, campaignProducts.id);

    const productIds = products.map((product) => product.id);
    const lots =
      productIds.length > 0
        ? await db
            .select({
              campaignProductId: campaignProductLots.campaignProductId,
              lotCode: campaignProductLots.lotCode,
              dateCode: campaignProductLots.dateCode,
              eligibilityStatus: campaignProductLots.eligibilityStatus,
              attributes: campaignProductLots.attributes,
            })
            .from(campaignProductLots)
            .where(inArray(campaignProductLots.campaignProductId, productIds))
        : [];

    const remedies = await db
      .select({
        code: campaignRemedyOptions.code,
        displayName: campaignRemedyOptions.displayName,
        active: campaignRemedyOptions.active,
        sortOrder: campaignRemedyOptions.sortOrder,
      })
      .from(campaignRemedyOptions)
      .where(eq(campaignRemedyOptions.campaignVersionId, versionId));

    const evidence = await db
      .select({
        category: campaignEvidenceRequirements.category,
        required: campaignEvidenceRequirements.required,
        minimumFiles: campaignEvidenceRequirements.minimumFiles,
        maximumFiles: campaignEvidenceRequirements.maximumFiles,
        allowedMimeTypes: campaignEvidenceRequirements.allowedMimeTypes,
        maximumFileSizeBytes: campaignEvidenceRequirements.maximumFileSizeBytes,
        instructions: campaignEvidenceRequirements.instructions,
      })
      .from(campaignEvidenceRequirements)
      .where(eq(campaignEvidenceRequirements.campaignVersionId, versionId));

    return mapToCampaignView({
      campaign: {
        slug: campaign.slug,
        code: campaign.code,
        defaultLocale: campaign.defaultLocale,
        versionNumber: version.versionNumber,
      },
      localization,
      products,
      lots,
      remedies,
      evidence,
    });
  }
}
