import type {
  CacheInvalidationResult,
  CampaignCacheInvalidator,
} from './port.js';

/**
 * Calls the consumer web app's `POST /api/revalidate` so a newly published
 * campaign version stops being served from cache immediately, instead of after
 * the web app's revalidate window elapses.
 *
 * The contract is deliberately narrow: this adapter sends a bare campaign slug
 * and the web app owns everything downstream — the cache tag it derives
 * (`campaign:<slug>`), which cached reads carry that tag, and how the tag is
 * expired. Nothing about the tag format is mirrored here, so there is no
 * constant to keep in sync across the two repositories; the sides agree only on
 * the request shape, and on slugs matching the DB's
 * `recall_campaigns_slug_format_chk` constraint.
 */

/** Kept short: the publish request awaits this, and the window is the fallback. */
const DEFAULT_TIMEOUT_MS = 3_000;

export class WebRevalidateCacheInvalidator implements CampaignCacheInvalidator {
  constructor(
    private readonly endpointUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async invalidateCampaign(slug: string): Promise<CacheInvalidationResult> {
    try {
      const response = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        // The status alone is safe to record — the body could echo the request
        // and the secret never appears in a response.
        return { invalidated: false, detail: `web app responded ${response.status}` };
      }
      return { invalidated: true };
    } catch (error) {
      const detail = error instanceof Error ? error.name : 'unknown error';
      return { invalidated: false, detail: `request failed (${detail})` };
    }
  }
}
