import { and, eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { claimDrafts, recallCampaigns } from '../../db/schema/index.js';
import { buildPublishedVersionQuery } from '../campaigns/drizzle-campaign-service.js';
import type { ClaimDraftService, CreatedClaimDraft } from './service.js';
import { generateDraftToken, hashDraftToken } from './tokens.js';

/** How long a draft remains usable for uploads and submission. 48 hours. */
const DRAFT_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Persists anonymous claim drafts in Postgres via Drizzle. The injected
 * {@link Database} is the dual-adapter union, so the same code runs against Neon
 * HTTP in production and node-postgres locally with no branching.
 */
export class DrizzleClaimDraftService implements ClaimDraftService {
  constructor(private readonly db: Database) {}

  async create(campaignSlug: string): Promise<CreatedClaimDraft | null> {
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

    const draftToken = generateDraftToken();
    const expiresAt = new Date(Date.now() + DRAFT_TTL_MS);

    const inserted = await db
      .insert(claimDrafts)
      .values({
        campaignId: campaign.id,
        campaignVersionId: versionId,
        tokenHash: hashDraftToken(draftToken),
        status: 'active',
        expiresAt,
      })
      .returning();
    // An insert that violates no constraint always returns the new row; a missing
    // row would indicate an unexpected driver/database state, so surface it as a
    // 500 rather than silently returning a malformed draft.
    const draft = inserted[0];
    if (!draft) throw new Error('Claim draft insert returned no row.');

    return {
      draftId: draft.id,
      draftToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  assertActive(_draftId: string, _draftToken: string): Promise<void> {
    return Promise.reject(new Error('Claim draft authentication is not implemented yet.'));
  }
}
