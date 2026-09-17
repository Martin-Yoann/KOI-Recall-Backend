import type {
  CacheInvalidationResult,
  CampaignCacheInvalidator,
} from './port.js';

/**
 * Used when no web revalidate endpoint is configured. Invalidation is a
 * best-effort optimisation on top of the revalidate window, so the correct
 * behaviour without configuration is to do nothing successfully — unlike the
 * other not-implemented adapters, this must not throw, or a publish would fail
 * over an optional cache hint.
 */
export class NotConfiguredCacheInvalidator implements CampaignCacheInvalidator {
  invalidateCampaign(_slug: string): Promise<CacheInvalidationResult> {
    return Promise.resolve({
      invalidated: false,
      detail: 'no web revalidate endpoint configured',
    });
  }
}
