import { describe, expect, it } from 'vitest';

import { deriveDocumentStatus } from '../src/modules/documents/document-status.js';

describe('deriveDocumentStatus', () => {
  it('maps authorized uploads before expiry to uploading', () => {
    expect(deriveDocumentStatus('authorized', 'pending', false)).toEqual({
      status: 'uploading',
      statusReason: null,
    });
  });

  it('maps authorized uploads past their authorization expiry to expired', () => {
    expect(deriveDocumentStatus('authorized', 'not_run', true)).toEqual({
      status: 'expired',
      statusReason: null,
    });
  });

  it('maps the intermediate uploaded row state to verifying', () => {
    // Written by phase 1 of reconciliation: bytes have landed but no verdict yet.
    expect(deriveDocumentStatus('uploaded', 'pending', false)).toEqual({
      status: 'verifying',
      statusReason: null,
    });
  });

  it('keeps scan_pending distinct from verified while a required scan runs', () => {
    expect(deriveDocumentStatus('verified', 'pending', false)).toEqual({
      status: 'scan_pending',
      statusReason: null,
    });
    expect(deriveDocumentStatus('verified', 'clean', false)).toEqual({
      status: 'verified',
      statusReason: null,
    });
    // Scanning disabled (or waived): verification alone satisfies policy.
    expect(deriveDocumentStatus('verified', 'not_run', false)).toEqual({
      status: 'verified',
      statusReason: null,
    });
  });

  it('gives rejections a sanitized reason derived from the scan result', () => {
    expect(deriveDocumentStatus('rejected', 'infected', false)).toEqual({
      status: 'rejected',
      statusReason: 'malware_detected',
    });
    expect(deriveDocumentStatus('rejected', 'not_run', false)).toEqual({
      status: 'rejected',
      statusReason: 'mime_mismatch',
    });
    expect(deriveDocumentStatus('rejected', 'failed', false).statusReason).toBe('mime_mismatch');
  });
});
