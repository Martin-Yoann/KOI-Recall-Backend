import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import {
  campaignLocalizations,
  caseConsumers,
  caseResolutions,
  recallCampaigns,
  recallCases,
} from '../../db/schema/index.js';
import type { CaseStatusLookupResponse } from '../../contracts/toc.js';
import type { SensitiveDataCryptoPort } from '../../platform/crypto/port.js';
import type { CaseStatusLookupService } from './case-status-lookup-service.js';
import {
  consumerNextAction,
  mapToPublicCaseState,
  publicStatusLabel,
  resolutionDisplayName,
} from './public-status.js';

/** Constant-time comparison of two fixed-digest hex strings. */
function secureHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length || leftBytes.length === 0) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Reads the whitelisted public case view from Postgres via Drizzle. The email
 * is only ever compared as a peppered HMAC against
 * `case_consumers.email_lookup_hash` — no PII is decrypted on this path.
 * Synthetic campaigns (`is_test_data = true`) are never queryable here so
 * demo cases cannot surface next to real consumer lookups in production.
 */
export class DrizzleCaseStatusLookupService implements CaseStatusLookupService {
  constructor(
    private readonly db: Database,
    private readonly crypto: SensitiveDataCryptoPort,
  ) {}

  async lookup(
    rawCaseReference: string,
    rawEmail: string,
  ): Promise<CaseStatusLookupResponse | null> {
    // The HMAC is computed before the database probe so both failure shapes do
    // the same work; the route renders one identical 404 ProblemDetails for
    // either outcome.
    const emailHash = await this.crypto.lookupHash(rawEmail.trim().toLowerCase());
    const caseReference = rawCaseReference.trim().toUpperCase();

    const [row] = await this.db
      .select({
        publicReference: recallCases.publicReference,
        caseStatus: recallCases.status,
        updatedAt: recallCases.updatedAt,
        campaignSlug: recallCampaigns.slug,
        resolutionStatus: caseResolutions.status,
        requestedType: caseResolutions.requestedType,
        approvedType: caseResolutions.approvedType,
        emailLookupHash: caseConsumers.emailLookupHash,
        campaignTitle: campaignLocalizations.title,
      })
      .from(recallCases)
      .innerJoin(recallCampaigns, eq(recallCampaigns.id, recallCases.campaignId))
      .innerJoin(caseConsumers, eq(caseConsumers.caseId, recallCases.id))
      .leftJoin(caseResolutions, eq(caseResolutions.caseId, recallCases.id))
      .leftJoin(
        campaignLocalizations,
        and(
          eq(campaignLocalizations.campaignVersionId, recallCases.campaignVersionId),
          eq(campaignLocalizations.locale, recallCases.locale),
        ),
      )
      .where(
        and(eq(recallCases.publicReference, caseReference), eq(recallCampaigns.isTestData, false)),
      )
      .limit(1);

    if (!row || !secureHexEqual(emailHash, row.emailLookupHash)) return null;

    const mapped = mapToPublicCaseState(row.caseStatus, {
      status: row.resolutionStatus ?? null,
      requestedType: row.requestedType ?? null,
      approvedType: row.approvedType ?? null,
    });

    return {
      caseReference: row.publicReference,
      campaignTitle: row.campaignTitle ?? row.campaignSlug,
      publicStatus: mapped.publicStatus,
      publicStatusLabel: publicStatusLabel(mapped.publicStatus),
      consumerNextAction: consumerNextAction(mapped.publicStatus),
      requestedResolution: resolutionDisplayName(row.requestedType ?? null),
      approvedResolution: mapped.approvedVisible
        ? resolutionDisplayName(row.approvedType ?? null)
        : null,
      lastUpdatedAt: row.updatedAt.toISOString(),
    };
  }
}
