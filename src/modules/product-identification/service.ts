import type { CampaignSnapshotReader } from './drizzle-snapshot-reader.js';
import { identify, type IdentificationInput, type IdentificationResult } from './policy.js';

/**
 * Orchestrates product identification: reads the versioned campaign snapshot
 * and evaluates the policy. Product Check and Claim Submission share this one
 * seam so their triage can never drift (ADR-0002 §2.2).
 */
export interface ProductIdentificationService {
  /**
   * Runs a preliminary identification against the campaign's currently
   * published version. Returns null when the campaign or its published version
   * is missing or not publicly visible.
   */
  check(input: IdentificationInput): Promise<IdentificationResult | null>;
}

export class DrizzleProductIdentificationService implements ProductIdentificationService {
  constructor(private readonly snapshotReader: CampaignSnapshotReader) {}

  async check(input: IdentificationInput): Promise<IdentificationResult | null> {
    const snapshot = await this.snapshotReader.readPublished(input.campaignSlug);
    if (!snapshot) return null;
    return identify(input, snapshot);
  }
}
