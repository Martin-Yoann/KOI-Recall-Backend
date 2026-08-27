import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseExecutor, DatabaseHandle } from '../../db/client.js';
import {
  campaignEvidenceRequirements,
  campaignLocalizations,
  campaignMessageTemplates,
  campaignProductIdentifiers,
  campaignProductLots,
  campaignProductVariants,
  campaignProducts,
  campaignRemedyOptions,
  campaignVersions,
  recallCampaigns,
} from '../../db/schema/index.js';
import type { CampaignView } from '../../contracts/toc.js';
import { CampaignValidationError } from '../../shared/errors.js';
import type {
  CampaignApproval,
  CampaignService,
  PublishVersionInput,
  PublishedCampaignQuery,
} from './service.js';
import { mapToCampaignView } from './mapper.js';

export function buildPublishedVersionQuery(
  db: DatabaseExecutor,
  campaignId: string,
  versionId: string,
) {
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
 * is the dual-adapter union, so the same code runs against Neon Serverless Pool in
 * production and node-postgres locally with no branching.
 */
export class DrizzleCampaignService implements CampaignService {
  constructor(private readonly handle: Pick<DatabaseHandle, 'db' | 'transaction'>) {}

  async getPublishedCampaign(query: PublishedCampaignQuery): Promise<CampaignView | null> {
    const db = this.handle.db;

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

    const [version] = await db
      .select({
        versionNumber: campaignVersions.versionNumber,
        privacyNoticeVersion: campaignVersions.privacyNoticeVersion,
        privacyNoticeUrl: campaignVersions.privacyNoticeUrl,
        publishedAt: campaignVersions.publishedAt,
      })
      .from(campaignVersions)
      .where(
        and(
          eq(campaignVersions.id, versionId),
          eq(campaignVersions.campaignId, campaign.id),
          eq(campaignVersions.status, 'published'),
        ),
      )
      .limit(1);
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

    // Unit UPCs are curated per ADR-0001 as variant identifiers; a UPC may
    // legitimately repeat across variants. `sku` is never treated as one.
    const unitUpcRows =
      productIds.length > 0
        ? await db
            .select({
              campaignProductId: campaignProducts.id,
              rawValue: campaignProductIdentifiers.rawValue,
            })
            .from(campaignProductIdentifiers)
            .innerJoin(
              campaignProductVariants,
              eq(campaignProductVariants.id, campaignProductIdentifiers.variantId),
            )
            .innerJoin(
              campaignProducts,
              eq(campaignProducts.id, campaignProductVariants.campaignProductId),
            )
            .where(
              and(
                inArray(campaignProducts.id, productIds),
                eq(campaignProductIdentifiers.identifierType, 'unit_upc'),
              ),
            )
        : [];
    const unitUpcsByProductId = new Map<string, string[]>();
    for (const row of unitUpcRows) {
      const existing = unitUpcsByProductId.get(row.campaignProductId) ?? [];
      existing.push(row.rawValue);
      unitUpcsByProductId.set(row.campaignProductId, existing);
    }
    const productsWithUpcs = products.map((product) => ({
      ...product,
      unitUpcs: unitUpcsByProductId.get(product.id) ?? [],
    }));

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
        privacyNoticeVersion: version.privacyNoticeVersion ?? 'legacy',
        privacyNoticeUrl: version.privacyNoticeUrl ?? 'https://privacy.example.invalid/legacy',
        publishedAt: version.publishedAt,
      },
      localization,
      products: productsWithUpcs,
      lots,
      remedies,
      evidence,
    });
  }

  /**
   * Atomically publishes a campaign version (T4.3/O4). The gate is not a
   * single env var — it is enforced per Campaign Version: every required
   * content piece must exist and the required approvals must be recorded
   * before status flips to `published`.
   */
  async publishVersion(input: PublishVersionInput): Promise<{
    versionNumber: number;
    publishedAt: string;
  }> {
    return this.handle.transaction(async (db) => {
      const [campaign] = await db
        .select({ id: recallCampaigns.id })
        .from(recallCampaigns)
        .where(eq(recallCampaigns.slug, input.campaignSlug))
        .limit(1);
      if (!campaign) throw new CampaignValidationError('Campaign was not found.');

      const [version] = await db
        .select({
          id: campaignVersions.id,
          status: campaignVersions.status,
        })
        .from(campaignVersions)
        .where(
          and(
            eq(campaignVersions.campaignId, campaign.id),
            eq(campaignVersions.versionNumber, input.versionNumber),
          ),
        )
        .limit(1);
      if (!version) throw new CampaignValidationError('Campaign Version was not found.');
      if (version.status !== 'draft') {
        throw new CampaignValidationError('Only a draft Campaign Version can be published.');
      }

      await this.assertPublishGate(db, input, version.id);

      const publishedAt = new Date();
      const [published] = await db
        .update(campaignVersions)
        .set({
          status: 'published',
          publishedAt,
          publishedBy: input.publishedBy,
          approvals: input.approvals,
        })
        .where(and(eq(campaignVersions.id, version.id), eq(campaignVersions.status, 'draft')))
        .returning({ id: campaignVersions.id });
      if (!published) {
        throw new CampaignValidationError('Only a draft Campaign Version can be published.');
      }
      await db
        .update(recallCampaigns)
        .set({ publishedVersionId: version.id, status: 'active' })
        .where(eq(recallCampaigns.id, campaign.id));

      return { versionNumber: input.versionNumber, publishedAt: publishedAt.toISOString() };
    });
  }

  /**
   * The publish gate: product scope, localized hazard/immediateAction/support,
   * >= 1 approved (active) remedy, evidence rules, message templates, and the
   * required approvals must all be present. Throws CampaignValidationError on
   * the first missing piece so the publish action never half-applies.
   */
  private async assertPublishGate(
    db: DatabaseExecutor,
    input: PublishVersionInput,
    versionId: string,
  ): Promise<void> {
    const [products] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(campaignProducts)
      .where(eq(campaignProducts.campaignVersionId, versionId));
    if (!products?.count || products.count === 0) {
      throw new CampaignValidationError('A published version must contain at least one product.');
    }

    const [localization] = await db
      .select({
        title: campaignLocalizations.title,
        summary: campaignLocalizations.summary,
        hazard: campaignLocalizations.hazard,
        immediateAction: campaignLocalizations.immediateAction,
        remedySummary: campaignLocalizations.remedySummary,
        supportEmail: campaignLocalizations.supportEmail,
      })
      .from(campaignLocalizations)
      .where(eq(campaignLocalizations.campaignVersionId, versionId))
      .limit(1);
    if (
      !localization ||
      !localization.title ||
      !localization.hazard ||
      !localization.immediateAction ||
      !localization.supportEmail
    ) {
      throw new CampaignValidationError(
        'A published version must include localized consumer copy: title, hazard, immediateAction, and support contact.',
      );
    }

    const [approvedRemedy] = await db
      .select({ id: campaignRemedyOptions.id })
      .from(campaignRemedyOptions)
      .where(
        and(
          eq(campaignRemedyOptions.campaignVersionId, versionId),
          eq(campaignRemedyOptions.active, true),
        ),
      )
      .limit(1);
    if (!approvedRemedy) {
      throw new CampaignValidationError(
        'A published version must include at least one active, approved Remedy.',
      );
    }

    const [evidence] = await db
      .select({ id: campaignEvidenceRequirements.id })
      .from(campaignEvidenceRequirements)
      .where(eq(campaignEvidenceRequirements.campaignVersionId, versionId))
      .limit(1);
    if (!evidence) {
      throw new CampaignValidationError('A published version must define evidence rules.');
    }

    const [messageTemplate] = await db
      .select({ id: campaignMessageTemplates.id })
      .from(campaignMessageTemplates)
      .where(eq(campaignMessageTemplates.campaignVersionId, versionId))
      .limit(1);
    if (!messageTemplate) {
      throw new CampaignValidationError(
        'A published version must include at least one message template.',
      );
    }

    validateRequiredApprovals(input.approvals);
  }
}

/**
 * Pure approval-gate check (T4.3/O4): business and legal_compliance sign-off
 * are mandatory; cpsc_if_applicable is optional — recorded when the recall is
 * CPSC-involved, otherwise omitted. Exported so the gate is unit-testable
 * without a database.
 */
export function validateRequiredApprovals(approvals: CampaignApproval[]): void {
  const requiredRoles = new Set<CampaignApproval['role']>(['business', 'legal_compliance']);
  const recorded = new Set(approvals.map((approval) => approval.role));
  for (const role of requiredRoles) {
    if (!recorded.has(role)) {
      throw new CampaignValidationError(`Approval by ${role} is required before publishing.`);
    }
  }
}
