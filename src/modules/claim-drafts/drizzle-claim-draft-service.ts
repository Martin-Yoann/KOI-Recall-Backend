import { and, eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { claimDrafts, recallCampaigns } from '../../db/schema/index.js';
import { DraftExpiredOrInvalidError } from '../../shared/errors.js';
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

  /**
   * Confirms the draft exists, the presented token matches the stored digest,
   * and the draft is still active and unexpired. Any failure maps to 410 via
   * {@link DraftExpiredOrInvalidError}; an expired/unknown draft is not
   * distinguished from an invalid token to avoid leaking draft existence.
   */
  async assertActive(draftId: string, draftToken: string): Promise<void> {
    const db = this.db;

    const [draft] = await db
      .select({
        status: claimDrafts.status,
        expiresAt: claimDrafts.expiresAt,
        tokenHash: claimDrafts.tokenHash,
      })
      .from(claimDrafts)
      .where(eq(claimDrafts.id, draftId))
      .limit(1);

    const presentedHash = hashDraftToken(draftToken);
    const now = Date.now();

    if (
      !draft ||
      draft.tokenHash !== presentedHash ||
      draft.status !== 'active' ||
      // Comparing the loaded Date avoids a second round-trip and stays
      // driver-agnostic across the Neon/node-pg union.
      draft.expiresAt.getTime() <= now
    ) {
      throw new DraftExpiredOrInvalidError(
        'The draft token is invalid, or the draft is no longer active or has expired.',
      );
    }
  }
}
