import { parseProductAttributes } from './attributes.js';

/**
 * ProductIdentificationPolicy — the single decision point for product
 * identification (ADR-0002). Pure, database-free, unit-testable.
 *
 * Identity and purchase corroboration are evaluated separately (V1.1/O3.1):
 * identification answers "is this in the recall scope"; corroboration answers
 * "is there a credible purchase trail". Corroboration must never be mistaken
 * for an identifier, and risk flags only affect queueing or info requests —
 * they never silently reject a legitimate consumer.
 */

/** A single physical variant's identifier as stored in the snapshot. */
export interface CampaignSnapshotIdentifier {
  variantId: string;
  type: 'sku' | 'unit_upc' | 'gtin14' | 'model' | 'style' | 'other';
  normalizedValue: string;
}

/** A variant of a product within a published campaign version. */
export interface CampaignSnapshotVariant {
  id: string;
  productId: string;
  model: string;
  identifiers: CampaignSnapshotIdentifier[];
}

/** One affected-lot row used by the legacy four-field matching path. */
export interface CampaignSnapshotLot {
  productId: string;
  lotCode: string;
  dateCode: string;
  eligibilityStatus: 'affected' | 'not_affected' | 'manual_review';
}

/** A product within the pinned campaign version. */
export interface CampaignSnapshotProduct {
  id: string;
  variants: CampaignSnapshotVariant[];
  /** Legacy flat attributes (shapes/flavors) — kept for the M1–M3 dual path. */
  attributes: Record<string, unknown>;
}

/**
 * Versioned rule snapshot passed to {@link identify}. Read consistently by the
 * snapshot reader so Product Check and Claim Submission evaluate the same
 * published rules.
 */
export interface CampaignSnapshot {
  campaignId: string;
  campaignSlug: string;
  versionNumber: number;
  products: CampaignSnapshotProduct[];
  lots: CampaignSnapshotLot[];
}

/**
 * Purchase-trail signals (V1.1/O3.1). Loosely typed on purpose: callers pass
 * the validated contract object whose optional Zod fields may carry `undefined`
 * (`exactOptionalPropertyTypes`); the policy only reads presence, so it accepts
 * the loose shape rather than fighting the optionality.
 */
export interface PurchaseEvidenceSignals {
  orderNumber?: string | undefined;
  platform?: string | undefined;
  sellerOrStore?: string | undefined;
  purchaseDate?: string | undefined;
  lineItemTitle?: string | undefined;
  lineItemSku?: string | undefined;
  quantity?: number | undefined;
  amountPaidMinor?: number | undefined;
  currency?: string | undefined;
  receiptDocumentIds?: string[] | undefined;
}

/** Recognition signals the consumer supplied, by mode. */
export interface ProductSignals {
  /** mode=product_identifiers: normalized identifier lookups (upc/gtin/model/style/lot/date…). */
  identifiers?: string[];
  /** Legacy four-field path: shape/flavor + lot/date codes (M1–M3 dual read). */
  shape?: string;
  flavor?: string;
  lotCode?: string;
  dateCode?: string;
  /**
   * mode=purchase_evidence: purchase trail (corroboration, not identity).
   * Explicitly allows `undefined` because validated contract objects carry
   * optional fields as `T | undefined` under `exactOptionalPropertyTypes`.
   */
  purchaseEvidence?: PurchaseEvidenceSignals | undefined;
}

export type IdentificationMode = 'product_identifiers' | 'purchase_evidence' | 'unknown';

export interface IdentificationInput {
  mode: IdentificationMode;
  campaignSlug: string;
  signals: ProductSignals;
}

export type MatchResult = 'potential_match' | 'manual_review' | 'not_matched';

export type PurchaseCorroboration = 'verified' | 'partial' | 'not_provided' | 'conflict';

/** ADR-0002 §2.1 — the policy's single entry point. */
export interface IdentificationResult {
  result: MatchResult;
  /** Stable reason codes, not human copy. Human copy comes from Localization. */
  reasonCodes: string[];
  /** 0|1|many matched variants. More than one => manual_review (ambiguity). */
  matchedVariantIds: string[];
  /** Which intake/evidence profile applies to this identification. */
  requiredEvidenceProfile:
    'exact_order_match' | 'order_evidence' | 'identifier_match' | 'manual_review' | 'incident';
  checkedCampaignVersion: number;
  /** V1.1/O3.1: purchase corroboration, evaluated independently. */
  purchaseCorroboration?: PurchaseCorroboration;
  /** V1.1/O3.1: risk flags only affect queueing / info requests. */
  riskFlags?: string[];
}

/** Stable reason codes (ADR-0002 §2.4 / contract draft §2.2). */
export const REASON_CODES = {
  IDENTIFIER_SINGLE_MATCH: 'identifier.single_match',
  IDENTIFIER_AMBIGUOUS_MULTI_MATCH: 'identifier.ambiguous_multi_match',
  IDENTIFIER_NO_MATCH: 'identifier.no_match',
  INPUT_INSUFFICIENT_SIGNALS: 'input.insufficient_signals',
  LOT_MANUAL_REVIEW: 'lot.manual_review',
  PURCHASE_EVIDENCE_VERIFIED: 'purchase_evidence.verified',
  PURCHASE_EVIDENCE_PARTIAL: 'purchase_evidence.partial',
  PURCHASE_EVIDENCE_CONFLICT: 'purchase_evidence.conflict',
} as const;

/** V1.1/O3.1 risk flags. */
export const RISK_FLAGS = {
  DUPLICATE_ORDER: 'duplicate_order',
  DUPLICATE_DOCUMENT: 'duplicate_document',
  IDENTIFIER_ORDER_CONFLICT: 'identifier_order_conflict',
  EVIDENCE_INSUFFICIENT: 'evidence_insufficient',
} as const;

/**
 * Identify the product against the pinned campaign snapshot.
 *
 * Rules (ADR-0002 §2.1 / §5):
 * - identifiers: single variant match => potential_match; multiple => manual_review;
 *   none => not_matched.
 * - legacy shape/flavor/lot/date path is honoured during M1–M3 dual read.
 * - no signals at all => manual_review (never reject).
 * - purchase evidence is evaluated separately and never affects `result`.
 */
export function identify(
  input: IdentificationInput,
  snapshot: CampaignSnapshot,
): IdentificationResult {
  const reasonCodes: string[] = [];
  const matchedVariantIds = new Set<string>();
  let sawInsufficient = false;

  if (input.mode === 'product_identifiers') {
    for (const product of snapshot.products) {
      for (const variant of product.variants) {
        const hit = variant.identifiers.some(
          (identifier) =>
            input.signals.identifiers?.some(
              (signal) =>
                signal.toLocaleLowerCase() === identifier.normalizedValue.toLocaleLowerCase(),
            ) ?? false,
        );
        if (hit) matchedVariantIds.add(variant.id);
      }
    }
  }

  // Legacy four-field dual-read path (M1–M3): shape/flavor/lot/date matching
  // against flat attributes and lot rows, exactly as the old matcher did.
  const legacyMatch = matchLegacy(input.signals, snapshot);
  for (const variantId of legacyMatch.matchedVariantIds) matchedVariantIds.add(variantId);

  if (matchedVariantIds.size === 0) {
    if (
      input.mode === 'unknown' ||
      input.mode === 'purchase_evidence' ||
      hasNoSignals(input.signals)
    ) {
      // purchase_evidence cannot confirm product identity — order evidence is
      // corroboration, never an identifier (V1.1/O3.1). Route to manual_review.
      sawInsufficient = true;
      reasonCodes.push(REASON_CODES.INPUT_INSUFFICIENT_SIGNALS);
    } else {
      reasonCodes.push(REASON_CODES.IDENTIFIER_NO_MATCH);
    }
  }

  const result: IdentificationResult = {
    result: legacyMatch.manualReview
      ? 'manual_review'
      : matchedVariantIds.size > 1
        ? 'manual_review'
        : matchedVariantIds.size === 1
          ? 'potential_match'
          : sawInsufficient
            ? 'manual_review'
            : 'not_matched',
    reasonCodes: legacyMatch.manualReview
      ? [REASON_CODES.LOT_MANUAL_REVIEW]
      : matchedVariantIds.size > 1
        ? [REASON_CODES.IDENTIFIER_AMBIGUOUS_MULTI_MATCH]
        : matchedVariantIds.size === 1
          ? [REASON_CODES.IDENTIFIER_SINGLE_MATCH]
          : reasonCodes,
    matchedVariantIds: [...matchedVariantIds],
    requiredEvidenceProfile: legacyMatch.manualReview
      ? 'manual_review'
      : deriveEvidenceProfile(input.mode, matchedVariantIds.size),
    checkedCampaignVersion: snapshot.versionNumber,
  };

  const corroboration = evaluateCorroboration(input);
  if (corroboration) {
    result.purchaseCorroboration = corroboration.status;
    if (corroboration.reasonCode) reasonCodes.push(corroboration.reasonCode);
    if (corroboration.riskFlags.length > 0) result.riskFlags = corroboration.riskFlags;
  }

  return result;
}

function matchLegacy(
  signals: ProductSignals,
  snapshot: CampaignSnapshot,
): { matchedVariantIds: string[]; manualReview: boolean } {
  const matched = new Set<string>();
  let manualReview = false;
  if (!signals.shape && !signals.flavor && !signals.lotCode && !signals.dateCode) {
    return { matchedVariantIds: [], manualReview };
  }

  const norm = (value: string | undefined) => (value ?? '').toLowerCase();
  const shape = norm(signals.shape);
  const flavor = norm(signals.flavor);
  const lotCode = norm(signals.lotCode);
  const dateCode = norm(signals.dateCode);

  for (const product of snapshot.products) {
    const attributes = parseProductAttributes(product.attributes);
    const shapes = (attributes.shapes ?? []).map(norm);
    const flavors = (attributes.flavors ?? []).map(norm);
    if (shape && !shapes.includes(shape)) continue;
    if (flavor && !flavors.includes(flavor)) continue;

    const lotMatches = snapshot.lots.filter(
      (lot) =>
        lot.productId === product.id &&
        (!lotCode || lot.lotCode.toLowerCase() === lotCode) &&
        (!dateCode || lot.dateCode.toLowerCase() === dateCode),
    );
    if (lotMatches.length === 0) continue;
    for (const lot of lotMatches) {
      if (lot.eligibilityStatus === 'affected' || lot.eligibilityStatus === 'manual_review') {
        if (lot.eligibilityStatus === 'manual_review') manualReview = true;
        for (const variant of product.variants) matched.add(variant.id);
      }
    }
  }
  return { matchedVariantIds: [...matched], manualReview };
}

function hasNoSignals(signals: ProductSignals): boolean {
  return (
    !signals.identifiers?.length &&
    !signals.shape &&
    !signals.flavor &&
    !signals.lotCode &&
    !signals.dateCode &&
    !signals.purchaseEvidence
  );
}

function deriveEvidenceProfile(
  mode: IdentificationMode,
  matchedVariantCount: number,
): IdentificationResult['requiredEvidenceProfile'] {
  // Ambiguity (or no product identity) always routes to the manual profile.
  if (matchedVariantCount > 1 || matchedVariantCount === 0) return 'manual_review';
  switch (mode) {
    case 'product_identifiers':
      return 'identifier_match';
    case 'purchase_evidence':
      // Phase 1 has no live order-index match: purchase evidence corroborates
      // but does not confirm identity, so the profile is order_evidence rather
      // than exact_order_match (the latter is reserved for a real order hit).
      return 'order_evidence';
    case 'unknown':
      return 'manual_review';
  }
}

/**
 * V1.1/O3.1 — purchase corroboration, independent of identity. Presence of an
 * Self-reported order details are at most partial until an authoritative
 * order-index adapter confirms them. `verified` is reserved for that future
 * server-side match and must never be inferred from client-selected fields.
 * Conflict detection (identifier vs order line) is surfaced as a risk flag,
 * never as a rejection.
 */
function evaluateCorroboration(input: IdentificationInput): {
  status: PurchaseCorroboration;
  reasonCode?: string;
  riskFlags: string[];
} | null {
  const evidence = input.signals.purchaseEvidence;
  if (!evidence || (!evidence.orderNumber && !evidence.receiptDocumentIds?.length)) return null;

  const riskFlags: string[] = [];
  const hasOrderNumber = Boolean(evidence.orderNumber);
  const hasAmount = typeof evidence.amountPaidMinor === 'number' && evidence.amountPaidMinor > 0;
  const hasDocument = Boolean(evidence.receiptDocumentIds?.length);

  let status: PurchaseCorroboration;
  let reasonCode: string | undefined;
  if (hasOrderNumber || hasDocument) {
    status = 'partial';
    reasonCode = REASON_CODES.PURCHASE_EVIDENCE_PARTIAL;
  } else {
    status = 'not_provided';
  }

  if (hasOrderNumber && !hasAmount && !hasDocument)
    riskFlags.push(RISK_FLAGS.EVIDENCE_INSUFFICIENT);
  if (riskFlags.length > 0) {
    status = 'partial';
    reasonCode = REASON_CODES.PURCHASE_EVIDENCE_PARTIAL;
  }

  return reasonCode === undefined ? { status, riskFlags } : { status, reasonCode, riskFlags };
}
