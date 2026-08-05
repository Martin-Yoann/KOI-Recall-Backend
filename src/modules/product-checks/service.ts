export interface ProductCheckInput {
  campaignSlug: string;
  shape: string;
  flavor: string;
  lotCode: string;
  dateCode: string;
}

export interface ProductCheckResult {
  result: 'potential_match' | 'not_matched' | 'manual_review';
  message: string;
  checkedCampaignVersion: number;
}

export interface ProductCheckService {
  /**
   * Runs a preliminary affected-product check against the campaign's currently
   * published version. Returns `null` when the campaign or its published
   * version is missing or not publicly visible; the result never blocks a
   * later claim submission, which re-checks eligibility authoritatively.
   */
  check(input: ProductCheckInput): Promise<ProductCheckResult | null>;
}
