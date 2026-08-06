/**
 * A newly created anonymous draft. The plaintext `draftToken` is shown to the
 * consumer exactly once; only its hash is persisted. The shape mirrors
 * `ClaimDraftResponse` in the Zod contract, so the route handler can parse the
 * service result directly as the HTTP response body.
 */
export interface CreatedClaimDraft {
  draftId: string;
  draftToken: string;
  expiresAt: string;
}

export interface ClaimDraftService {
  /**
   * Creates an expiring anonymous draft bound to the campaign's currently
   * published version. Returns `null` when the campaign slug is unknown or has
   * no published version, so the caller can map it to a 404.
   */
  create(campaignSlug: string): Promise<CreatedClaimDraft | null>;
  assertActive(draftId: string, draftToken: string): Promise<void>;
}
