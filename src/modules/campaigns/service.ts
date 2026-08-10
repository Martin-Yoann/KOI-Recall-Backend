import type { CampaignView } from '../../contracts/toc.js';

export interface PublishedCampaignQuery {
  slug: string;
  locale: 'en-US';
}

/** A structured approval recorded on a campaign version (T4.3/O4). */
export interface CampaignApproval {
  role: 'business' | 'legal_compliance' | 'cpsc_if_applicable';
  approvedBy: string;
  approvedAt: string;
}

export interface PublishVersionInput {
  campaignSlug: string;
  versionNumber: number;
  /** The actor performing the publish action. */
  publishedBy: string;
  /** Sign-offs already collected; publishing fails if any required role is missing. */
  approvals: CampaignApproval[];
}

export interface CampaignService {
  /**
   * Resolves the currently published public campaign for the slug and locale.
   * Returns `null` when the campaign, its published version, or the requested
   * localization is missing or not publicly visible.
   */
  getPublishedCampaign(query: PublishedCampaignQuery): Promise<CampaignView | null>;

  /**
   * Atomically publishes a campaign version (T4.3/O4). Validates that the
   * version is draft, every required content piece exists (product scope,
   * localized hazard/immediateAction/support, >= 1 approved remedy, evidence
   * rules, message templates), and the required approvals are recorded — then
   * flips status to `published` and points the campaign at this version.
   * Throws {@link ClaimValidationError}-style errors via CampaignValidationError.
   */
  publishVersion(input: PublishVersionInput): Promise<{
    versionNumber: number;
    publishedAt: string;
  }>;
}
