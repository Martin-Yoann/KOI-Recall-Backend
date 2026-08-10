import type {
  IdentificationInput,
  IdentificationResult,
} from '../product-identification/policy.js';

/**
 * The product-check service seam (ADR-0002 §2.2). Product Check and Claim
 * Submission both resolve through this one policy so their triage can never
 * drift. The input is the three-mode discriminated union; the output carries
 * stable reason codes and (V1.1) purchase corroboration and risk flags.
 */
export interface ProductCheckService {
  /**
   * Runs a preliminary identification against the campaign's currently
   * published version. Returns `null` when the campaign or its published
   * version is missing or not publicly visible; the result never blocks a
   * later claim submission, which re-checks eligibility authoritatively.
   */
  check(input: IdentificationInput): Promise<IdentificationResult | null>;
}
