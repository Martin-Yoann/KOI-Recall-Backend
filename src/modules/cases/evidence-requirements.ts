import { ClaimValidationError } from '../../shared/errors.js';

/**
 * The two document rules a submission must satisfy, extracted from `submit` so each can be
 * tested without a database and read without scrolling past a transaction.
 *
 * Both are refused with `ClaimValidationError`, and both are deliberately all-or-nothing:
 * a submission either carries documents that satisfy the pinned Campaign Version, or it is
 * rejected with the ids that failed. There is no partial acceptance, because a claim's
 * evidence is what the reviewer will work from.
 */

/** The columns of `document_uploads` these rules look at. */
export interface SubmittableDocument {
  id: string;
  draftId: string | null;
  category: string;
  uploadStatus: string;
  scanStatus: string;
}

/**
 * T5.5/O5 (D5): a claim may only attach documents that are verified AND scan-clean.
 * `verified` proves media-type reconciliation, not safety — the malware gate is separate
 * and mandatory.
 */
export function assertDocumentsSubmittable(input: {
  documents: readonly SubmittableDocument[];
  /** What the consumer sent, so an unknown or already-claimed id is named rather than ignored. */
  submittedDocumentIds: readonly string[];
  draftId: string;
  malwareScanRequired: boolean;
}): void {
  const failingDocumentIds = new Set<string>();

  for (const document of input.documents) {
    if (
      document.draftId !== input.draftId ||
      document.uploadStatus !== 'verified' ||
      (document.scanStatus !== 'clean' &&
        (input.malwareScanRequired || document.scanStatus !== 'not_run'))
    ) {
      failingDocumentIds.add(document.id);
    }
  }

  for (const documentId of input.submittedDocumentIds) {
    if (!input.documents.some((document) => document.id === documentId)) {
      // Unknown or already-claimed rows are equally un-submittable; naming them keeps
      // the consumer-side fallback actionable either way.
      failingDocumentIds.add(documentId);
    }
  }

  if (failingDocumentIds.size > 0) {
    throw new ClaimValidationError(
      `Selected Documents [${[...failingDocumentIds].sort().join(', ')}] did not pass submission requirements: ` +
        'every Document must be verified, satisfy the configured malware-scan policy, and be owned by the active Claim Draft.',
    );
  }
}

/** A row of `campaign_evidence_requirements` for the pinned Campaign Version. */
export interface EvidenceRule {
  category: string;
  required: boolean;
  minimumFiles: number;
  maximumFiles: number;
}

/**
 * The pinned Campaign Version's evidence requirements.
 *
 * T4.2/ADR-0003 M3: an exact order match (or credible order evidence) waives the
 * proof-of-purchase minimum — the order itself is the purchase proof. Upper bounds still
 * apply to every category, including the waived one, so an order match cannot be used to
 * attach more files than the campaign allows.
 */
export function assertEvidenceRequirements(input: {
  documents: readonly SubmittableDocument[];
  rules: readonly EvidenceRule[];
  /** True only when every product matched a real order index; self-reported evidence never waives. */
  waivesProofOfPurchase: boolean;
}): void {
  for (const rule of input.rules) {
    const count = input.documents.filter((document) => document.category === rule.category).length;
    const waivedByOrderMatch = input.waivesProofOfPurchase && rule.category === 'proof_of_purchase';
    if (
      count > rule.maximumFiles ||
      (!waivedByOrderMatch && (count < rule.minimumFiles || (rule.required && count === 0)))
    ) {
      throw new ClaimValidationError(
        'Selected Documents do not satisfy the pinned Campaign evidence requirements.',
      );
    }
  }
}
