export interface CacheInvalidationResult {
  /**
   * False when the invalidation could not be performed. That is not an error
   * condition: the campaign read still expires on its own revalidate window, so
   * a failed invalidation only widens staleness back to that window.
   */
  invalidated: boolean;
  /** Short reason, for logging. Never contains the configured secret. */
  detail?: string;
}

/**
 * Expires the consumer web app's cached copy of published campaign content.
 *
 * Publishing is the moment a recall notice changes for consumers, so it is the
 * point at which the web cache has to be told. This is deliberately best-effort:
 * a web app that is unreachable, slow, or misconfigured must never block or fail
 * a publish, because the content is already committed by then.
 */
export interface CampaignCacheInvalidator {
  invalidateCampaign(slug: string): Promise<CacheInvalidationResult>;
}
