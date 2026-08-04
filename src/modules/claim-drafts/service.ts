export interface ClaimDraftService {
  create(campaignSlug: string): Promise<unknown>;
  assertActive(draftId: string, draftToken: string): Promise<void>;
}
