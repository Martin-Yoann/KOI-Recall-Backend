import { describe, expect, it } from 'vitest';

import {
  assertDocumentsSubmittable,
  assertEvidenceRequirements,
  type EvidenceRule,
  type SubmittableDocument,
} from '../src/modules/cases/evidence-requirements.js';
import { deriveSubmissionStatus } from '../src/modules/cases/submission-status.js';
import type { CaseStatus } from '../src/modules/workflow/policy.js';
import { ClaimValidationError } from '../src/shared/errors.js';

/** Rules extracted from `submit`, tested here rather than through a database submission. */

describe('deriveSubmissionStatus', () => {
  // The whole rule, all eight combinations, so its precedence is visible in one place.
  const table: [string, string, boolean, CaseStatus, string][] = [
    ['no', 'potential_match', false, 'submitted', 'an ordinary claim'],
    ['no', 'potential_match', true, 'submitted', 'no incident, so the switch does not reach it'],
    ['yes', 'potential_match', true, 'escalated', 'a reported injury whose products are verified'],
    ['yes', 'potential_match', false, 'submitted', 'phase 2 off: byte for byte the old rule'],
    ['yes', 'no_match', true, 'triage', 'product verification outranks escalation'],
    ['unsure', 'potential_match', true, 'triage', 'the consumer cannot confirm the product'],
    ['unsure', 'potential_match', false, 'triage', 'and the switch does not change that'],
    ['unsure', 'no_match', true, 'triage', 'both reasons at once'],
  ];

  for (const [incidentAnswer, result, flag, expected, note] of table) {
    it(`${note}: ${incidentAnswer} / ${result} / switch ${flag ? 'on' : 'off'} → ${expected}`, () => {
      const derived = deriveSubmissionStatus({
        incidentAnswer,
        productResults: [{ evaluation: { result } }],
        incidentEscalatedStatus: flag,
      });
      expect(derived.caseStatus).toBe(expected);
    });
  }

  it('marks the subtype from the incident answer, not from the status', () => {
    // An injury that lands in triage is still an injury: the subtype is what routes it to
    // compliance review, and a case is with compliance by way of its derived stage, not by
    // its status. Losing the subtype here would lose the compliance fact entirely.
    const triaged = deriveSubmissionStatus({
      incidentAnswer: 'unsure',
      productResults: [{ evaluation: { result: 'potential_match' } }],
      incidentEscalatedStatus: true,
    });
    expect(triaged).toEqual({
      hasIncident: true,
      caseStatus: 'triage',
      subtype: 'injury_hazard',
    });
  });

  it('treats any answer other than no as an incident', () => {
    for (const incidentAnswer of ['yes', 'unsure', 'YES']) {
      expect(
        deriveSubmissionStatus({
          incidentAnswer,
          productResults: [{ evaluation: { result: 'potential_match' } }],
          incidentEscalatedStatus: false,
        }).hasIncident,
      ).toBe(true);
    }
  });
});

function document(overrides: Partial<SubmittableDocument> = {}): SubmittableDocument {
  return {
    id: 'doc-1',
    draftId: 'draft-1',
    category: 'product_photo',
    uploadStatus: 'verified',
    scanStatus: 'clean',
    ...overrides,
  };
}

function rule(overrides: Partial<EvidenceRule> = {}): EvidenceRule {
  return {
    category: 'product_photo',
    required: true,
    minimumFiles: 1,
    maximumFiles: 3,
    ...overrides,
  };
}

describe('assertDocumentsSubmittable', () => {
  it('accepts documents that are verified, clean and owned by the draft', () => {
    expect(() =>
      assertDocumentsSubmittable({
        documents: [document(), document({ id: 'doc-2' })],
        submittedDocumentIds: ['doc-1', 'doc-2'],
        draftId: 'draft-1',
        malwareScanRequired: false,
      }),
    ).not.toThrow();
  });

  it('refuses a document that belongs to another draft', () => {
    expect(() =>
      assertDocumentsSubmittable({
        documents: [document({ draftId: 'someone-elses-draft' })],
        submittedDocumentIds: ['doc-1'],
        draftId: 'draft-1',
        malwareScanRequired: false,
      }),
    ).toThrow(/doc-1/);
  });

  it('refuses a document that was never verified', () => {
    expect(() =>
      assertDocumentsSubmittable({
        documents: [document({ uploadStatus: 'pending' })],
        submittedDocumentIds: ['doc-1'],
        draftId: 'draft-1',
        malwareScanRequired: false,
      }),
    ).toThrow(ClaimValidationError);
  });

  it('refuses a scan that came back as anything but clean', () => {
    expect(() =>
      assertDocumentsSubmittable({
        documents: [document({ scanStatus: 'infected' })],
        submittedDocumentIds: ['doc-1'],
        draftId: 'draft-1',
        malwareScanRequired: false,
      }),
    ).toThrow(/did not pass submission requirements/);
  });

  it('lets an unscanned document through while scanning is not required', () => {
    expect(() =>
      assertDocumentsSubmittable({
        documents: [document({ scanStatus: 'not_run' })],
        submittedDocumentIds: ['doc-1'],
        draftId: 'draft-1',
        malwareScanRequired: false,
      }),
    ).not.toThrow();
  });

  it('refuses the same document once scanning is required', () => {
    // The malware gate is a configuration decision, not a default: turning it on must be
    // enough to stop unscanned uploads, without any other change.
    expect(() =>
      assertDocumentsSubmittable({
        documents: [document({ scanStatus: 'not_run' })],
        submittedDocumentIds: ['doc-1'],
        draftId: 'draft-1',
        malwareScanRequired: true,
      }),
    ).toThrow(/did not pass submission requirements/);
  });

  it('names an id that is not in the draft at all', () => {
    expect(() =>
      assertDocumentsSubmittable({
        documents: [],
        submittedDocumentIds: ['doc-gone'],
        draftId: 'draft-1',
        malwareScanRequired: false,
      }),
    ).toThrow(/doc-gone/);
  });

  it('lists every failing id, sorted, in one message', () => {
    expect(() =>
      assertDocumentsSubmittable({
        documents: [document({ id: 'doc-b', uploadStatus: 'pending' })],
        submittedDocumentIds: ['doc-b', 'doc-a'],
        draftId: 'draft-1',
        malwareScanRequired: false,
      }),
    ).toThrow(/\[doc-a, doc-b\]/);
  });
});

describe('assertEvidenceRequirements', () => {
  it('accepts a category that meets its minimum', () => {
    expect(() =>
      assertEvidenceRequirements({
        documents: [document()],
        rules: [rule()],
        waivesProofOfPurchase: false,
      }),
    ).not.toThrow();
  });

  it('refuses a category below its minimum', () => {
    expect(() =>
      assertEvidenceRequirements({ documents: [], rules: [rule()], waivesProofOfPurchase: false }),
    ).toThrow(/evidence requirements/);
  });

  it('requires one file for a category flagged required even with a zero minimum', () => {
    expect(() =>
      assertEvidenceRequirements({
        documents: [],
        rules: [rule({ required: true, minimumFiles: 0 })],
        waivesProofOfPurchase: false,
      }),
    ).toThrow(/evidence requirements/);
  });

  it('refuses more files than the campaign allows', () => {
    expect(() =>
      assertEvidenceRequirements({
        documents: [document({ id: '1' }), document({ id: '2' }), document({ id: '3' })],
        rules: [rule({ maximumFiles: 2 })],
        waivesProofOfPurchase: false,
      }),
    ).toThrow(/evidence requirements/);
  });

  it('waives the proof-of-purchase minimum on an exact order match', () => {
    // The order is the purchase proof, so the receipt is not required on top of it.
    expect(() =>
      assertEvidenceRequirements({
        documents: [document({ category: 'product_photo' })],
        rules: [rule({ category: 'proof_of_purchase' }), rule()],
        waivesProofOfPurchase: true,
      }),
    ).not.toThrow();
  });

  it('does not waive the maximum for the waived category', () => {
    // Otherwise an order match would be a way around the campaign's file limits.
    expect(() =>
      assertEvidenceRequirements({
        documents: [
          document({ id: '1', category: 'proof_of_purchase' }),
          document({ id: '2', category: 'proof_of_purchase' }),
        ],
        rules: [rule({ category: 'proof_of_purchase', maximumFiles: 1 })],
        waivesProofOfPurchase: true,
      }),
    ).toThrow(/evidence requirements/);
  });

  it('waives nothing but the proof of purchase', () => {
    expect(() =>
      assertEvidenceRequirements({
        documents: [],
        rules: [rule({ category: 'product_photo' })],
        waivesProofOfPurchase: true,
      }),
    ).toThrow(/evidence requirements/);
  });

  it('does not waive anything when the match came from self-reported evidence', () => {
    expect(() =>
      assertEvidenceRequirements({
        documents: [],
        rules: [rule({ category: 'proof_of_purchase' })],
        waivesProofOfPurchase: false,
      }),
    ).toThrow(/evidence requirements/);
  });
});
