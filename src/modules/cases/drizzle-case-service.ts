import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt, inArray, lte } from 'drizzle-orm';

import {
  claimSubmissionResponseSchema,
  type ClaimSubmissionRequest,
  type ClaimSubmissionResponse,
} from '../../contracts/toc.js';
import type { DatabaseExecutor, DatabaseHandle } from '../../db/client.js';
import {
  campaignEvidenceRequirements,
  campaignMessageTemplates,
  campaignProductLots,
  campaignProducts,
  campaignRemedyOptions,
  campaignVersions,
  caseConsents,
  caseConsumers,
  caseEvents,
  claimedProducts,
  claimDrafts,
  communications,
  documentUploads,
  idempotencyRecords,
  incidents,
  outboxEvents,
  recallCampaigns,
  recallCases,
  reportabilityReviews,
  submissionSnapshots,
} from '../../db/schema/index.js';
import type { Ciphertext, SensitiveDataCryptoPort } from '../../platform/crypto/port.js';
import {
  ClaimConflictError,
  ClaimValidationError,
  DraftExpiredOrInvalidError,
  isUniqueViolationWithConstraint,
  ResourceNotFoundError,
} from '../../shared/errors.js';
import { evaluateProductCheck } from '../product-checks/matcher.js';
import { hashDraftToken } from '../claim-drafts/tokens.js';
import {
  canonicalJson,
  generateCaseReference,
  hashCanonicalRequest,
  normalizeAddress,
  normalizeEmail,
  normalizeOrderNumber,
} from './normalization.js';
import type { CaseService, ClaimSubmissionCommand } from './service.js';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_UNIQUE_CONSTRAINT = 'idempotency_records_endpoint_key_uidx';
const CASE_REFERENCE_ATTEMPTS = 3;
/**
 * Maps a claimed product's intake mode + matcher result onto the versioned
 * Evidence Profile (ADR-0003 M3, D3). The profile decides which evidence
 * categories are required and whether proof of purchase can be waived.
 */
function deriveEvidenceProfile(
  mode: ClaimSubmissionRequest['products'][number]['identificationMode'],
  result: 'potential_match' | 'not_matched' | 'manual_review',
): 'exact_order_match' | 'order_evidence' | 'identifier_match' | 'manual_review' | 'incident' {
  if (mode === 'purchase_evidence' && result === 'potential_match') return 'exact_order_match';
  if (mode === 'purchase_evidence') return 'order_evidence';
  if (mode === 'product_identifiers' && result === 'potential_match') return 'identifier_match';
  return 'manual_review';
}

/**
 * O3.1/T4.4: purchase corroboration from the claimed product's purchase trail.
 * verified = order number + amount; partial = order number or receipt only;
 * not_provided = no purchase trail at all; conflict = input flagged inconsistent.
 */
export function deriveCorroboration(
  product: ClaimSubmissionRequest['products'][number],
): 'verified' | 'partial' | 'not_provided' | 'conflict' {
  const evidence = product.purchaseEvidence;
  if (!evidence) return 'not_provided';
  const hasOrder = Boolean(evidence.orderNumber);
  const hasAmount = typeof evidence.amountPaidMinor === 'number' && evidence.amountPaidMinor > 0;
  const hasDocument = Boolean(evidence.receiptDocumentIds?.length);
  if (hasOrder && hasAmount) return 'verified';
  if (hasOrder || hasDocument) return 'partial';
  return 'not_provided';
}

/**
 * O3.1/T4.4: risk flags derived from the purchase trail. Flags only affect
 * queueing or info requests — they never silently reject a legitimate consumer.
 */
export function deriveRiskFlags(
  product: ClaimSubmissionRequest['products'][number],
): string[] | null {
  const evidence = product.purchaseEvidence;
  if (!evidence) return null;
  const hasOrder = Boolean(evidence.orderNumber);
  const hasAmount = typeof evidence.amountPaidMinor === 'number' && evidence.amountPaidMinor > 0;
  const hasDocument = Boolean(evidence.receiptDocumentIds?.length);
  if (hasOrder && !hasAmount && !hasDocument) return ['evidence_insufficient'];
  return null;
}

interface EncryptedProduct {
  orderNumber?: Ciphertext;
  orderNumberLookupHash?: string;
  /** O3.1/T4.4: AEAD-encrypted purchase trail (amount/currency/original
   * address/platform/seller). Never logged or exported in plaintext. */
  purchaseEvidence?: Ciphertext;
  /** Normalized-HMAC order number for duplicate detection. */
  purchaseEvidenceLookupHash?: string;
}

interface EncryptedSubmission {
  firstName: Ciphertext;
  lastName: Ciphertext;
  email: Ciphertext;
  recipientEmail: Ciphertext;
  phone?: Ciphertext;
  address: Ciphertext;
  emailLookupHash: string;
  addressLookupHash: string;
  products: EncryptedProduct[];
  snapshot: Ciphertext;
  incidentNarrative?: Ciphertext;
}

export class DrizzleCaseService implements CaseService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly crypto: SensitiveDataCryptoPort,
    private readonly referenceGenerator: () => string = generateCaseReference,
    private readonly beforeIdempotencyInsert: () => Promise<void> = () => Promise.resolve(),
  ) {}

  async submit(command: ClaimSubmissionCommand): Promise<ClaimSubmissionResponse> {
    const endpoint = `/v1/recall-campaigns/${command.campaignSlug}/claims`;
    const requestHash = hashCanonicalRequest(command.body);
    const keyHash = await this.crypto.lookupHash(command.idempotencyKey);
    const submittedAt = new Date();

    const encrypted = await this.encryptSubmission(command.body);

    const transaction = this.handle.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          draftId: claimDrafts.id,
          draftCampaignId: claimDrafts.campaignId,
          campaignVersionId: claimDrafts.campaignVersionId,
          tokenHash: claimDrafts.tokenHash,
          draftStatus: claimDrafts.status,
          expiresAt: claimDrafts.expiresAt,
          campaignId: recallCampaigns.id,
          campaignSlug: recallCampaigns.slug,
          campaignStatus: recallCampaigns.status,
          versionCampaignId: campaignVersions.campaignId,
        })
        .from(claimDrafts)
        .innerJoin(recallCampaigns, eq(recallCampaigns.id, claimDrafts.campaignId))
        .innerJoin(campaignVersions, eq(campaignVersions.id, claimDrafts.campaignVersionId))
        .where(eq(claimDrafts.id, command.body.draftId))
        .for('update', { of: claimDrafts });

      if (!locked) {
        throw new DraftExpiredOrInvalidError(
          'The draft token is invalid, or the draft is no longer active or has expired.',
        );
      }
      if (locked.tokenHash !== hashDraftToken(command.body.draftToken)) {
        throw new DraftExpiredOrInvalidError(
          'The draft token is invalid, or the draft is no longer active or has expired.',
        );
      }
      if (locked.draftStatus === 'submitted') {
        const concurrentWinner = await this.findIdempotency(endpoint, keyHash, tx, submittedAt);
        if (concurrentWinner) return this.replay(concurrentWinner, requestHash);
        throw new ClaimConflictError('The Claim Draft has already been submitted.');
      }
      if (locked.draftStatus !== 'active' || locked.expiresAt.getTime() <= submittedAt.getTime()) {
        throw new DraftExpiredOrInvalidError(
          'The draft token is invalid, or the draft is no longer active or has expired.',
        );
      }
      if (
        locked.campaignSlug !== command.campaignSlug ||
        locked.campaignStatus !== 'active' ||
        locked.campaignId !== locked.draftCampaignId ||
        locked.versionCampaignId !== locked.campaignId
      ) {
        throw new ResourceNotFoundError('Campaign was not found for this Claim Draft.');
      }

      const existing = await this.findIdempotency(endpoint, keyHash, tx, submittedAt);
      if (existing) return this.replay(existing, requestHash);
      await tx
        .delete(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.endpoint, endpoint),
            eq(idempotencyRecords.keyHash, keyHash),
            lte(idempotencyRecords.expiresAt, submittedAt),
          ),
        )
        .returning({ id: idempotencyRecords.id });

      this.validateConsents(command.body);
      if (new Set(command.body.documentIds).size !== command.body.documentIds.length) {
        throw new ClaimValidationError('Document IDs must be unique.');
      }

      const submittedProductIds = [
        ...new Set(command.body.products.map((product) => product.campaignProductId)),
      ];
      const ownedProducts = await tx
        .select({ id: campaignProducts.id, attributes: campaignProducts.attributes })
        .from(campaignProducts)
        .where(
          and(
            eq(campaignProducts.campaignVersionId, locked.campaignVersionId),
            inArray(campaignProducts.id, submittedProductIds),
          ),
        );
      if (ownedProducts.length !== submittedProductIds.length) {
        throw new ClaimValidationError(
          'Every submitted Product must belong to the pinned Campaign Version.',
        );
      }

      const [remedy] = await tx
        .select({
          id: campaignRemedyOptions.id,
          requiresMailingAddress: campaignRemedyOptions.requiresMailingAddress,
        })
        .from(campaignRemedyOptions)
        .where(
          and(
            eq(campaignRemedyOptions.campaignVersionId, locked.campaignVersionId),
            eq(campaignRemedyOptions.code, command.body.remedyCode),
            eq(campaignRemedyOptions.active, true),
          ),
        )
        .limit(1);
      if (!remedy) {
        throw new ClaimValidationError(
          'The selected Remedy is not active for the pinned Campaign Version.',
        );
      }
      // M3/T4.1 (D4/D8): the contract allows omitting the address; the service
      // enforces it per Remedy. Refund may omit it; Replacement (or any remedy
      // flagged requiresMailingAddress) must supply currentDeliveryAddress.
      if (remedy.requiresMailingAddress && !command.body.consumer.currentDeliveryAddress) {
        throw new ClaimValidationError(
          'currentDeliveryAddress is required for the selected Remedy.',
        );
      }

      // Evaluate product identification BEFORE evidence rules so the Evidence
      // Profile (T4.2) can relax requirements (e.g. exact order match waives
      // proof of purchase). M3: claimed-product fields are optional recognition
      // signals — the legacy four-field matcher gets empty strings for absent
      // ones and stays total through the M1–M4 dual-read window.
      const productLots = await tx
        .select({
          campaignProductId: campaignProductLots.campaignProductId,
          lotCode: campaignProductLots.lotCode,
          dateCode: campaignProductLots.dateCode,
          eligibilityStatus: campaignProductLots.eligibilityStatus,
        })
        .from(campaignProductLots)
        .where(inArray(campaignProductLots.campaignProductId, submittedProductIds));
      const productEvaluations = command.body.products.map((product) => ({
        product,
        evaluation: evaluateProductCheck(
          {
            shape: product.shape ?? '',
            flavor: product.flavor ?? '',
            lotCode: product.lotCode ?? '',
            dateCode: product.dateCode ?? '',
          },
          ownedProducts.filter((ownedProduct) => ownedProduct.id === product.campaignProductId),
          productLots.filter((lot) => lot.campaignProductId === product.campaignProductId),
        ),
      }));
      const evidenceProfiles = productEvaluations.map(({ product, evaluation }) =>
        deriveEvidenceProfile(product.identificationMode, evaluation.result),
      );
      // O3.1: an exact order match (or order evidence) may waive proof of
      // purchase; a manual_review product still needs the manual profile.
      const waivesProofOfPurchase = evidenceProfiles.some(
        (profile) => profile === 'exact_order_match' || profile === 'order_evidence',
      );

      const selectedDocuments = await tx
        .select({
          id: documentUploads.id,
          draftId: documentUploads.draftId,
          category: documentUploads.category,
          uploadStatus: documentUploads.uploadStatus,
          scanStatus: documentUploads.scanStatus,
        })
        .from(documentUploads)
        .where(inArray(documentUploads.id, command.body.documentIds))
        .for('update');
      // T5.5/O5 (D5): a claim may only attach documents that are verified AND
      // scan-clean. `verified` proves media-type reconciliation, not safety —
      // the malware gate is separate and mandatory.
      if (
        selectedDocuments.length !== command.body.documentIds.length ||
        selectedDocuments.some(
          (document) =>
            document.draftId !== locked.draftId ||
            document.uploadStatus !== 'verified' ||
            document.scanStatus !== 'clean',
        )
      ) {
        throw new ClaimValidationError(
          'Every selected Document must be verified, scan-clean, and owned by the active Claim Draft.',
        );
      }

      const evidenceRules = await tx
        .select({
          category: campaignEvidenceRequirements.category,
          required: campaignEvidenceRequirements.required,
          minimumFiles: campaignEvidenceRequirements.minimumFiles,
          maximumFiles: campaignEvidenceRequirements.maximumFiles,
        })
        .from(campaignEvidenceRequirements)
        .where(eq(campaignEvidenceRequirements.campaignVersionId, locked.campaignVersionId));
      for (const rule of evidenceRules) {
        const count = selectedDocuments.filter(
          (document) => document.category === rule.category,
        ).length;
        // T4.2/ADR-0003 M3: an exact order match (or credible order evidence)
        // waives the proof-of-purchase minimum — the order itself is the
        // purchase proof. Upper bounds still apply to every category.
        const waivedByOrderMatch = waivesProofOfPurchase && rule.category === 'proof_of_purchase';
        if (
          count > rule.maximumFiles ||
          (!waivedByOrderMatch && (count < rule.minimumFiles || (rule.required && count === 0)))
        ) {
          throw new ClaimValidationError(
            'Selected Documents do not satisfy the pinned Campaign evidence requirements.',
          );
        }
      }

      const hasIncident = command.body.incidentAnswer !== 'no';
      const caseStatus =
        command.body.incidentAnswer === 'unsure' ||
        productEvaluations.some(({ evaluation }) => evaluation.result !== 'potential_match')
          ? 'triage'
          : 'submitted';

      const caseId = randomUUID();
      const communicationId = randomUUID();
      let caseReference: string | undefined;
      for (let attempt = 0; attempt < CASE_REFERENCE_ATTEMPTS; attempt += 1) {
        const candidate = this.referenceGenerator();
        const [inserted] = await tx
          .insert(recallCases)
          .values({
            id: caseId,
            publicReference: candidate,
            campaignId: locked.campaignId,
            campaignVersionId: locked.campaignVersionId,
            locale: command.body.locale,
            subtype: hasIncident ? 'injury_hazard' : 'standard',
            status: caseStatus,
            incidentFlag: hasIncident,
            submittedAt,
          })
          .onConflictDoNothing({ target: recallCases.publicReference })
          .returning({ id: recallCases.id });
        if (inserted) {
          caseReference = candidate;
          break;
        }
      }
      if (!caseReference) throw new Error('Unable to allocate a unique Case Reference.');

      const response: ClaimSubmissionResponse = {
        caseReference,
        submittedAt: submittedAt.toISOString(),
        emailStatus: 'queued',
        nextStep: 'Keep this reference. We will email you after your claim has been received.',
      };

      await tx.insert(caseConsumers).values({
        caseId,
        keyVersion: encrypted.firstName.keyVersion,
        firstNameEncrypted: encrypted.firstName.value,
        lastNameEncrypted: encrypted.lastName.value,
        emailEncrypted: encrypted.email.value,
        emailLookupHash: encrypted.emailLookupHash,
        phoneEncrypted: encrypted.phone?.value,
        addressEncrypted: encrypted.address.value,
        addressLookupHash: encrypted.addressLookupHash,
        countryCode: command.body.consumer.currentDeliveryAddress?.countryCode ?? 'US',
      });
      await tx.insert(claimedProducts).values(
        productEvaluations.map(({ product, evaluation }, index) => ({
          caseId,
          campaignProductId: product.campaignProductId,
          quantity: product.quantity,
          // M3/T4.1: legacy columns remain NOT NULL until M4; store empty for
          // absent optional signals so the dual-read window stays compatible.
          shape: product.shape ?? '',
          flavor: product.flavor ?? '',
          lotCode: product.lotCode ?? '',
          dateCode: product.dateCode ?? '',
          purchaseChannel: product.purchaseChannel,
          purchaseDate: product.purchaseDate,
          orderNumberEncrypted: encrypted.products[index]?.orderNumber?.value,
          orderNumberLookupHash: encrypted.products[index]?.orderNumberLookupHash,
          checkResult: evaluation.result,
          // M3/T4.1 audit columns (T2): how the product was identified and why.
          // Stable reason codes only — never the legacy human message.
          identificationMode: product.identificationMode,
          reasonCodes:
            evaluation.result === 'potential_match'
              ? ['identifier.single_match']
              : evaluation.result === 'manual_review'
                ? ['input.insufficient_signals']
                : ['identifier.no_match'],
          inputSnapshot: {
            shape: product.shape ?? null,
            flavor: product.flavor ?? null,
            lotCode: product.lotCode ?? null,
            dateCode: product.dateCode ?? null,
            identifiers: product.identifiers ?? null,
            purchaseEvidence: product.purchaseEvidence ?? null,
          },
          // O3.1/T4.4: persist the AEAD-encrypted purchase trail and its
          // normalized HMAC; corroboration/risk flags are audited alongside.
          purchaseEvidenceEncrypted: encrypted.products[index]?.purchaseEvidence?.value ?? null,
          purchaseEvidenceKeyVersion:
            encrypted.products[index]?.purchaseEvidence?.keyVersion ?? null,
          purchaseEvidenceLookupHash: encrypted.products[index]?.purchaseEvidenceLookupHash ?? null,
          purchaseCorroboration: deriveCorroboration(product),
          riskFlags: deriveRiskFlags(product),
        })),
      );
      await tx.insert(caseConsents).values(
        command.body.consents.map((consent) => ({
          caseId,
          consentType: consent.type,
          textVersion: consent.textVersion,
          accepted: consent.accepted,
          acceptedAt: submittedAt,
        })),
      );
      await tx.insert(submissionSnapshots).values({
        caseId,
        schemaVersion: 'phase1-v1',
        keyVersion: encrypted.snapshot.keyVersion,
        encryptedPayload: encrypted.snapshot.value,
        payloadSha256: requestHash,
      });
      if (hasIncident) {
        const details = command.body.incidentDetails!;
        const eventTypes = details.eventTypes?.length ? details.eventTypes : ['unknown'];
        const occurredDateUnknown = details.occurredDateUnknown || !details.occurredDate;
        const [incident] = await tx
          .insert(incidents)
          .values({
            caseId,
            answer: command.body.incidentAnswer,
            eventTypes,
            narrativeKeyVersion: encrypted.incidentNarrative!.keyVersion,
            narrativeEncrypted: encrypted.incidentNarrative!.value,
            occurredAt: details.occurredDate
              ? new Date(`${details.occurredDate}T00:00:00.000Z`)
              : null,
            occurredDateUnknown,
            injurySeverity: details.injurySeverity,
            medicalTreatment: details.medicalTreatment,
            usedAsIntended: details.usedAsIntended,
            companyObtainedAt: submittedAt,
          })
          .returning({ id: incidents.id });
        await tx
          .insert(reportabilityReviews)
          .values({ incidentId: incident!.id, status: 'pending' });
      }
      await tx
        .update(documentUploads)
        .set({
          caseId,
          draftId: null,
          categorySlot: null,
          uploadStatus: 'linked',
          linkedAt: submittedAt,
          updatedAt: submittedAt,
        })
        .where(inArray(documentUploads.id, command.body.documentIds));
      await tx
        .update(claimDrafts)
        .set({ status: 'submitted', submittedCaseId: caseId, updatedAt: submittedAt })
        .where(eq(claimDrafts.id, locked.draftId));
      await tx.insert(caseEvents).values({
        caseId,
        eventType: 'claim.submitted',
        actorType: 'consumer',
        occurredAt: submittedAt,
        data: {
          locale: command.body.locale,
          productCount: command.body.products.length,
          documentCount: command.body.documentIds.length,
          incidentAnswer: command.body.incidentAnswer,
        },
      });
      const [template] = await tx
        .select({ id: campaignMessageTemplates.id })
        .from(campaignMessageTemplates)
        .where(
          and(
            eq(campaignMessageTemplates.campaignVersionId, locked.campaignVersionId),
            eq(campaignMessageTemplates.locale, command.body.locale),
            eq(campaignMessageTemplates.templateType, 'claim_confirmation'),
            eq(campaignMessageTemplates.active, true),
          ),
        )
        .orderBy(desc(campaignMessageTemplates.version))
        .limit(1);
      if (!template) {
        throw new Error('An active Claim confirmation template is required.');
      }
      await this.beforeIdempotencyInsert();
      await tx.insert(idempotencyRecords).values({
        endpoint,
        keyHash,
        requestHash,
        statusCode: 201,
        responseBody: { ...response },
        caseId,
        expiresAt: new Date(submittedAt.getTime() + IDEMPOTENCY_TTL_MS),
      });
      await tx.insert(communications).values({
        id: communicationId,
        caseId,
        templateId: template.id,
        messageKey: `claim-confirmation:${caseId}`,
        channel: 'email',
        recipientKeyVersion: encrypted.recipientEmail.keyVersion,
        recipientEncrypted: encrypted.recipientEmail.value,
        status: 'queued',
      });
      await tx.insert(outboxEvents).values({
        aggregateType: 'recall_case',
        aggregateId: caseId,
        eventType: 'claim.confirmation.requested',
        deduplicationKey: `claim-confirmation:${caseReference}`,
        payload: { communicationId, caseId },
      });
      return response;
    });

    try {
      return await transaction;
    } catch (error) {
      if (!isUniqueViolationWithConstraint(error, IDEMPOTENCY_UNIQUE_CONSTRAINT)) throw error;
      const concurrentWinner = await this.findIdempotency(
        endpoint,
        keyHash,
        this.handle.db,
        submittedAt,
      );
      if (!concurrentWinner) throw error;
      return this.replay(concurrentWinner, requestHash);
    }
  }

  private async findIdempotency(
    endpoint: string,
    keyHash: string,
    executor: DatabaseExecutor = this.handle.db,
    unexpiredAt: Date = new Date(),
  ) {
    const [record] = await executor
      .select({
        requestHash: idempotencyRecords.requestHash,
        responseBody: idempotencyRecords.responseBody,
      })
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.endpoint, endpoint),
          eq(idempotencyRecords.keyHash, keyHash),
          gt(idempotencyRecords.expiresAt, unexpiredAt),
        ),
      )
      .limit(1);
    return record;
  }

  private replay(
    existing: { requestHash: string; responseBody: Record<string, unknown> },
    requestHash: string,
  ): ClaimSubmissionResponse {
    if (existing.requestHash !== requestHash) {
      throw new ClaimConflictError('The Idempotency-Key was already used for a different request.');
    }
    return claimSubmissionResponseSchema.parse(existing.responseBody);
  }

  private validateConsents(body: ClaimSubmissionRequest): void {
    const consentTypes = body.consents.map((item) => item.type);
    if (
      consentTypes.length !== 2 ||
      new Set(consentTypes).size !== 2 ||
      !consentTypes.includes('privacy_notice') ||
      !consentTypes.includes('information_accuracy')
    ) {
      throw new ClaimValidationError('Both required consents must be accepted exactly once.');
    }
  }

  private async encryptSubmission(body: ClaimSubmissionRequest): Promise<EncryptedSubmission> {
    // M3/T4.1: the delivery address is optional at the contract layer. When
    // absent (e.g. Refund, or manual_review with no address yet), store an
    // empty canonical address so case_consumers' NOT NULL columns stay intact
    // and the record remains auditable. `countryCode` defaults to US.
    const normalizedAddress = normalizeAddress(
      body.consumer.currentDeliveryAddress ? { ...body.consumer.currentDeliveryAddress } : {},
    );
    const normalizedEmail = normalizeEmail(body.consumer.email);
    const [
      firstName,
      lastName,
      email,
      recipientEmail,
      phone,
      address,
      emailLookupHash,
      addressLookupHash,
      snapshot,
      products,
    ] = await Promise.all([
      this.crypto.encrypt(body.consumer.firstName),
      this.crypto.encrypt(body.consumer.lastName),
      this.crypto.encrypt(normalizedEmail),
      this.crypto.encrypt(normalizedEmail),
      body.consumer.phone ? this.crypto.encrypt(body.consumer.phone) : Promise.resolve(undefined),
      this.crypto.encrypt(normalizedAddress),
      this.crypto.lookupHash(normalizedEmail),
      this.crypto.lookupHash(normalizedAddress),
      this.crypto.encrypt(canonicalJson(body)),
      Promise.all(
        body.products.map(async (product): Promise<EncryptedProduct> => {
          // O3.1/T4.4: the purchase trail (amount, currency, original order
          // address, platform, seller, line items) is sensitive buying data —
          // AEAD-encrypted as one payload, never logged or exported in
          // plaintext. Only a normalized HMAC of the order number is stored,
          // for duplicate detection.
          const purchaseEvidence = product.purchaseEvidence;
          const [
            orderNumber,
            orderNumberLookupHash,
            purchaseEvidenceEncrypted,
            purchaseEvidenceLookupHash,
          ] = await Promise.all([
            product.orderNumber
              ? this.crypto.encrypt(product.orderNumber)
              : Promise.resolve(undefined),
            product.orderNumber
              ? this.crypto.lookupHash(normalizeOrderNumber(product.orderNumber))
              : Promise.resolve(undefined),
            purchaseEvidence
              ? this.crypto.encrypt(
                  canonicalJson({
                    orderNumber: purchaseEvidence.orderNumber,
                    platform: purchaseEvidence.platform,
                    sellerOrStore: purchaseEvidence.sellerOrStore,
                    purchaseDate: purchaseEvidence.purchaseDate,
                    lineItemTitle: purchaseEvidence.lineItemTitle,
                    lineItemSku: purchaseEvidence.lineItemSku,
                    quantity: purchaseEvidence.quantity,
                    amountPaidMinor: purchaseEvidence.amountPaidMinor,
                    currency: purchaseEvidence.currency,
                    receiptDocumentIds: purchaseEvidence.receiptDocumentIds,
                  }),
                )
              : Promise.resolve(undefined),
            purchaseEvidence?.orderNumber
              ? this.crypto.lookupHash(normalizeOrderNumber(purchaseEvidence.orderNumber))
              : Promise.resolve(undefined),
          ]);
          return {
            ...(orderNumber ? { orderNumber } : {}),
            ...(orderNumberLookupHash ? { orderNumberLookupHash } : {}),
            ...(purchaseEvidenceEncrypted ? { purchaseEvidence: purchaseEvidenceEncrypted } : {}),
            ...(purchaseEvidenceLookupHash ? { purchaseEvidenceLookupHash } : {}),
          };
        }),
      ),
    ]);

    return {
      firstName,
      lastName,
      email,
      recipientEmail,
      ...(phone ? { phone } : {}),
      address,
      emailLookupHash,
      addressLookupHash,
      snapshot,
      products,
      ...(body.incidentDetails
        ? { incidentNarrative: await this.crypto.encrypt(body.incidentDetails.narrative) }
        : {}),
    };
  }
}
