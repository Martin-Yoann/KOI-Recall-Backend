export interface PublishedCampaignQuery {
  slug: string;
  locale: 'en-US';
}

export interface CampaignService {
  getPublishedCampaign(query: PublishedCampaignQuery): Promise<unknown>;
}
