import type { documentUploadStatusEnum, malwareScanStatusEnum } from '../../db/schema/index.js';
import type { DraftDocumentStatus, DraftDocumentStatusReason } from '../../contracts/toc.js';

/** The full union of `document_uploads.upload_status` values. */
export type UploadStatus = (typeof documentUploadStatusEnum.enumValues)[number];
/** The subset that can legitimately appear in a draft documents listing. */
export type ListedUploadStatus = Exclude<UploadStatus, 'deletion_pending' | 'deleted' | 'linked'>;
export type ScanStatus = (typeof malwareScanStatusEnum.enumValues)[number];

/**
 * Statuses that appear in the draft documents listing: rows already handed to
 * deletion, or linked to a submitted case, are intentionally absent so DELETE
 * and submission are reflected immediately.
 */
export const LISTED_UPLOAD_STATUSES: readonly ListedUploadStatus[] = [
  'authorized',
  'uploaded',
  'verified',
  'rejected',
];

export interface DerivedDocumentStatus {
  status: DraftDocumentStatus;
  statusReason: DraftDocumentStatusReason | null;
}

/**
 * Deterministic server-side derivation of the public six-state upload model
 * from persisted columns (consumer-front contract §7):
 *
 * - `authorized`   → uploading  (token issued; bytes not reconciled yet)
 * - `uploaded`     → verifying  (blob callback received; reconciliation in flight)
 * - `verified`     → scan_pending when a malware scan is queued, else verified
 * - `rejected`     → rejected with a sanitized reason
 * - never reconciled before expiry → expired
 *
 * Total switch over the upload-status union: adding a row state without a
 * public counterpart is a compile error, never an unmapped state.
 */
export function deriveDocumentStatus(
  uploadStatus: ListedUploadStatus,
  scanStatus: ScanStatus,
  expired: boolean,
): DerivedDocumentStatus {
  switch (uploadStatus) {
    case 'rejected':
      return {
        status: 'rejected',
        // No scanner is wired yet, so today every rejection is a media-type
        // divergence recorded during reconciliation; `malware_detected` becomes
        // reachable once scans actually run.
        statusReason: scanStatus === 'infected' ? 'malware_detected' : 'mime_mismatch',
      };
    case 'uploaded':
      return { status: 'verifying', statusReason: null };
    case 'authorized':
      return expired
        ? { status: 'expired', statusReason: null }
        : { status: 'uploading', statusReason: null };
    case 'verified':
      return scanStatus === 'pending'
        ? { status: 'scan_pending', statusReason: null }
        : { status: 'verified', statusReason: null };
  }
}
