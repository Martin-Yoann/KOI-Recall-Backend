import type { CampaignView } from '../../contracts/toc.js';

export interface PublishedCampaignQuery {
  slug: string;
  locale: 'en-US';
}

export interface CampaignService {
  /**
   * Resolves the currently published public campaign for the slug and locale.
   * Returns `null` when the campaign, its published version, or the requested
   * localization is missing or not publicly visible.
   */
  getPublishedCampaign(query: PublishedCampaignQuery): Promise<CampaignView | null>;
}
