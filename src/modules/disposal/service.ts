import { createHash } from 'node:crypto';

import type { DatabaseExecutor } from '../../db/client.js';
import type { DisposalInstructionStep, DisposalReferenceImage } from '../../db/schema/index.js';
import type { DisposalInstructionView } from '../../contracts/disposal.js';
import type {
  DisposalApprovalMaterial,
  DisposalApprovalScope,
  DisposalBatchReviewStatus,
  DisposalEligibilityStatus,
  DisposalInstructionStatus,
  DisposalMeasure,
  DisposalPolicySnapshot,
  DisposalPolicyState,
  DisposalTaskStatus,
  DisposalAuthorizationStatus,
} from './policy.js';

/**
 * The disposal service port.
 *
 * Every method that can move a task towards permission re-derives its decision
 * from {@link import('./policy.js').evaluateDisposal} against freshly read state.
 * Nothing accepts an authorization decision from a caller.
 */

/** Number of random bytes backing a visitor task token. 32 bytes (256 bits). */
const TASK_TOKEN_RANDOM_BYTES = 32;

export function generateTaskToken(): string {
  const bytes = new Uint8Array(TASK_TOKEN_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/** Only the digest is persisted, mirroring `claim_drafts.token_hash`. */
export function hashTaskToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * What a task needs in order to be evaluated. `policyState` is built by the
 * service from the database, never supplied by a caller — that is what keeps the
 * gate honest.
 */
export interface DisposalTaskRecord {
  id: string;
  status: DisposalTaskStatus;
  eligibilityStatus: DisposalEligibilityStatus;
  /** Owner references; the task is always bound to a draft, plus a case once one exists. */
  draftId: string | null;
  caseId: string | null;
  instructionVersionId: string;
  instructionStatus: DisposalInstructionStatus | null;
  instructionVersionNumber: number | null;
  instructionTitle: string | null;
  declarationTextVersion: string | null;
  approvalAuthorizesDisposal: boolean;
  latestBatchId: string | null;
  latestBatchReviewStatus: DisposalBatchReviewStatus | null;
  holdActive: boolean;
  authorizationId: string | null;
  authorizationStatus: DisposalAuthorizationStatus | null;
  version: number;
  policyState: DisposalPolicyState;
}

export interface DisposalTaskProductRecord {
  campaignProductId: string;
  quantity: number;
  confirmedAffected: boolean;
}

export interface DisposalTaskDetail {
  task: DisposalTaskRecord;
  products: DisposalTaskProductRecord[];
  /** The evaluated policy, so callers never re-derive it. */
  snapshot: DisposalPolicySnapshot;
  /**
   * Approved instruction content, or null when it must be withheld because the
   * version is unapproved, withdrawn, or not backed by an authorizing approval.
   * Null is a real answer: nothing improvised may be shown in its place.
   */
  instruction: DisposalInstructionView | null;
  expiresAt: string;
}

export interface ConfirmEligibilityInput {
  taskId: string;
  eligibilityStatus: Exclude<DisposalEligibilityStatus, 'pending_confirmation'>;
  note: string;
  actorStaffUserId: string;
  /** Optimistic token from the page; a stale tab cannot decide an old state. */
  expectedVersion: number;
}

export interface SubmitEvidenceBatchInput {
  taskId: string;
  taskToken: string;
  idempotencyKey: string;
  /** Attachments already uploaded and technically verified. */
  documents: Array<{
    documentId: string;
    campaignProductId?: string | undefined;
    quantityCovered?: number | undefined;
  }>;
  /** Business retention deadline; null means "no configured expiry". */
  retentionUntil: Date | null;
}

export interface ReviewBatchInput {
  batchId: string;
  decision: 'accepted' | 'needs_resubmission';
  rationale: string;
  reasonCode?: string;
  actorStaffUserId: string;
  actorRole: string;
}

export interface PlaceHoldInput {
  taskId: string;
  reason: 'incident_evidence_retention' | 'compliance_investigation' | 'other';
  note: string;
  /** Null for the automatic incident pause, which no person pressed. */
  actorStaffUserId: string | null;
}

export interface ReleaseHoldInput {
  taskId: string;
  note: string;
  actorStaffUserId: string;
}

export interface RecordDeclarationInput {
  taskId: string;
  taskToken: string;
  declarationTextVersion: string;
  /**
   * Exactly one of these. An authorization to declare against, or the exception
   * that explains why there is none — a consumer who already disposed of the
   * unit must be able to say so without a back-dated permission.
   */
  authorizationId?: string;
  exceptionType?: 'already_disposed_before_authorization' | 'evidence_unavailable' | 'other';
  exceptionNote?: string;
}

export interface PublishInstructionInput {
  campaignVersionId: string;
  locale: string;
  actorStaffUserId: string;
}

export interface WithdrawInstructionInput {
  instructionVersionId: string;
  reason: string;
  actorStaffUserId: string;
}

export interface CreateInstructionVersionInput {
  campaignVersionId: string;
  locale: string;
  title: string;
  steps: DisposalInstructionStep[];
  referenceImages: DisposalReferenceImage[];
  videoUrl?: string;
  safetyWarnings: string[];
  recognitionRequirements: string[];
  declarationTextVersion: string;
}

/**
 * Records the material a decision rests on.
 *
 * Only the material's *identity* is supplied — its type, scope, and the measure
 * it selects. Whether that combination authorizes consumer disposal is computed
 * server-side by `authorizesConsumerDisposal`, so no caller can assert an
 * authorization into existence.
 */
export interface RecordInstructionApprovalInput {
  instructionVersionId: string;
  materialType: DisposalApprovalMaterial;
  scope: DisposalApprovalScope;
  measure: DisposalMeasure;
  referenceText?: string | undefined;
  effectiveFrom?: Date | undefined;
  effectiveUntil?: Date | undefined;
  actorStaffUserId: string;
}

export interface DisposalQueueRowView {
  taskId: string;
  caseReference: string | null;
  eligibilityStatus: DisposalEligibilityStatus;
  instructionVersionNumber: number | null;
  evidenceReviewStatus: DisposalBatchReviewStatus | null;
  authorizationStatus: DisposalAuthorizationStatus | null;
  holdActive: boolean;
  blockingReasons: string[];
  productCount: number;
  createdAt: string;
}

export interface InstructionVersionSummary {
  id: string;
  campaignVersionId: string;
  versionNumber: number;
  locale: string;
  status: DisposalInstructionStatus;
  title: string;
  authorizesConsumerDisposal: boolean;
  approvalCount: number;
}

export interface DisposalService {
  /**
   * Opens a task at claim submission, or returns null when disposal does not
   * apply. Null is the normal case: it is what keeps the feature dark until an
   * approved, authorizing instruction version exists for the pinned campaign
   * version — no flag, just the absence of content.
   */
  createTaskForSubmission(
    tx: DatabaseExecutor,
    input: {
      draftId: string;
      /** Null when no case exists yet; the task is always bound to a draft. */
      caseId: string | null;
      campaignVersionId: string;
      productIds: string[];
      /** Whether the claim reports a safety incident; drives the automatic pause. */
      hasIncident: boolean;
    },
  ): Promise<{ taskId: string; token: string } | null>;

  /** Visitor read. Returns null for an unknown task or a wrong/expired token. */
  getTaskForVisitor(taskId: string, taskToken: string): Promise<DisposalTaskDetail | null>;

  /**
   * Admin read. Staff never hold the visitor token, so this path is authorised
   * by permission alone and returns the same policy evaluation the consumer
   * surface sees.
   */
  getTaskForAdmin(taskId: string): Promise<DisposalTaskDetail | null>;

  confirmEligibility(input: ConfirmEligibilityInput): Promise<void>;

  /**
   * Marks one product as confirmed affected. A human act: a potential match is
   * never promoted to confirmed by inference.
   */
  confirmProductAffected(input: {
    taskId: string;
    campaignProductId: string;
    quantity: number;
  }): Promise<void>;

  submitEvidenceBatch(
    input: SubmitEvidenceBatchInput,
  ): Promise<{ batchId: string; reviewStatus: DisposalBatchReviewStatus }>;

  reviewBatch(input: ReviewBatchInput): Promise<void>;

  placeHold(input: PlaceHoldInput): Promise<void>;
  releaseHold(input: ReleaseHoldInput): Promise<void>;

  /**
   * Issues the permission. Refuses unless the full gate passes; the caller
   * cannot supply the decision.
   */
  issueAuthorization(input: {
    taskId: string;
    actorStaffUserId: string;
  }): Promise<{ authorizationId: string }>;

  recordDeclaration(input: RecordDeclarationInput): Promise<void>;

  /** Suspends every live authorization resting on this version. Returns the count. */
  withdrawInstruction(input: {
    instructionVersionId: string;
    reason: string;
    actorStaffUserId: string;
  }): Promise<number>;

  /**
   * Content authoring. A version starts as a draft and only becomes usable once
   * published; edits create a new version rather than mutating an approved one,
   * mirroring how campaign versions work.
   */
  createInstructionVersion(
    input: CreateInstructionVersionInput,
  ): Promise<{ instructionVersionId: string; versionNumber: number }>;

  /** Records approval material and reports whether it authorizes disposal. */
  recordInstructionApproval(input: RecordInstructionApprovalInput): Promise<{
    approvalId: string;
    authorizesConsumerDisposal: boolean;
  }>;

  /**
   * Publishes instruction content. Deliberately does NOT require an authorizing
   * approval: a version backed only by a Notice of Violation is a real and
   * visible state — the content exists and nothing is enabled, which is exactly
   * what D25 asks the surface to show.
   */
  publishInstructionVersion(input: {
    instructionVersionId: string;
    actorStaffUserId: string;
  }): Promise<void>;

  listInstructionVersions(campaignVersionId?: string): Promise<InstructionVersionSummary[]>;

  /** Admin queue: tasks awaiting a person, newest first. */
  listQueue(filter?: { limit?: number }): Promise<DisposalQueueRowView[]>;
}
