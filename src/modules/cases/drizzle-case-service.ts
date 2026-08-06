import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  claimSubmissionResponseSchema,
  type ClaimSubmissionRequest,
  type ClaimSubmissionResponse,
} from '../../contracts/toc.js';
import type { DatabaseHandle } from '../../db/client.js';
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

interface EncryptedProduct {
  orderNumber?: Ciphertext;
  orderNumberLookupHash?: string;
}

interface EncryptedSubmission {
  firstName: Ciphertext;
  lastName: Ciphertext;
  email: Ciphertext;
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
  ) {}

  async submit(command: ClaimSubmissionCommand): Promise<ClaimSubmissionResponse> {
    const endpoint = `/v1/recall-campaigns/${command.campaignSlug}/claims`;
    const requestHash = hashCanonicalRequest(command.body);
    const keyHash = await this.crypto.lookupHash(command.idempotencyKey);
    const existing = await this.findIdempotency(endpoint, keyHash);
    if (existing) return this.replay(existing, requestHash);

    const encrypted = await this.encryptSubmission(command.body);
    const submittedAt = new Date();

    return this.handle.transaction(async (tx) => {
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
        .for('update');

      if (!locked) {
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
      if (
        locked.tokenHash !== hashDraftToken(command.body.draftToken) ||
        locked.draftStatus !== 'active' ||
        locked.expiresAt.getTime() <= submittedAt.getTime()
      ) {
        throw new DraftExpiredOrInvalidError(
          'The draft token is invalid, or the draft is no longer active or has expired.',
        );
      }

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
        .select({ id: campaignRemedyOptions.id })
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

      const selectedDocuments = await tx
        .select({
          id: documentUploads.id,
          draftId: documentUploads.draftId,
          category: documentUploads.category,
          uploadStatus: documentUploads.uploadStatus,
        })
        .from(documentUploads)
        .where(inArray(documentUploads.id, command.body.documentIds))
        .for('update');
      if (
        selectedDocuments.length !== command.body.documentIds.length ||
        selectedDocuments.some(
          (document) => document.draftId !== locked.draftId || document.uploadStatus !== 'verified',
        )
      ) {
        throw new ClaimValidationError(
          'Every selected Document must be verified and owned by the active Claim Draft.',
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
        if (
          count < rule.minimumFiles ||
          count > rule.maximumFiles ||
          (rule.required && count === 0)
        ) {
          throw new ClaimValidationError(
            'Selected Documents do not satisfy the pinned Campaign evidence requirements.',
          );
        }
      }

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
          product,
          ownedProducts.filter((ownedProduct) => ownedProduct.id === product.campaignProductId),
          productLots.filter((lot) => lot.campaignProductId === product.campaignProductId),
        ),
      }));
      const hasIncident = command.body.incidentAnswer !== 'no';
      const caseStatus =
        command.body.incidentAnswer === 'unsure' ||
        productEvaluations.some(({ evaluation }) => evaluation.result === 'not_matched')
          ? 'triage'
          : 'submitted';

      const caseId = randomUUID();
      const caseReference = generateCaseReference();
      const communicationId = randomUUID();
      const response: ClaimSubmissionResponse = {
        caseReference,
        submittedAt: submittedAt.toISOString(),
        emailStatus: 'queued',
        nextStep: 'Keep this reference. We will email you after your claim has been received.',
      };

      await tx.insert(recallCases).values({
        id: caseId,
        publicReference: caseReference,
        campaignId: locked.campaignId,
        campaignVersionId: locked.campaignVersionId,
        locale: command.body.locale,
        subtype: hasIncident ? 'injury_hazard' : 'standard',
        status: caseStatus,
        incidentFlag: hasIncident,
        submittedAt,
      });
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
        countryCode: command.body.consumer.mailingAddress.countryCode,
      });
      await tx.insert(claimedProducts).values(
        productEvaluations.map(({ product, evaluation }, index) => ({
          caseId,
          campaignProductId: product.campaignProductId,
          quantity: product.quantity,
          shape: product.shape,
          flavor: product.flavor,
          lotCode: product.lotCode,
          dateCode: product.dateCode,
          purchaseChannel: product.purchaseChannel,
          purchaseDate: product.purchaseDate,
          orderNumberEncrypted: encrypted.products[index]?.orderNumber?.value,
          orderNumberLookupHash: encrypted.products[index]?.orderNumberLookupHash,
          checkResult: evaluation.result,
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
      await tx.insert(communications).values({
        id: communicationId,
        caseId,
        templateId: template.id,
        messageKey: `claim-confirmation:${caseId}`,
        channel: 'email',
        recipientKeyVersion: encrypted.email.keyVersion,
        recipientEncrypted: encrypted.email.value,
        status: 'queued',
      });
      await tx.insert(outboxEvents).values({
        aggregateType: 'recall_case',
        aggregateId: caseId,
        eventType: 'claim.confirmation.requested',
        deduplicationKey: `claim-confirmation:${keyHash}`,
        payload: { communicationId, caseId },
      });
      await tx.insert(idempotencyRecords).values({
        endpoint,
        keyHash,
        requestHash,
        statusCode: 201,
        responseBody: { ...response },
        caseId,
        expiresAt: new Date(submittedAt.getTime() + IDEMPOTENCY_TTL_MS),
      });

      return response;
    });
  }

  private async findIdempotency(endpoint: string, keyHash: string) {
    const [record] = await this.handle.db
      .select({
        requestHash: idempotencyRecords.requestHash,
        responseBody: idempotencyRecords.responseBody,
      })
      .from(idempotencyRecords)
      .where(
        and(eq(idempotencyRecords.endpoint, endpoint), eq(idempotencyRecords.keyHash, keyHash)),
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
    const normalizedAddress = normalizeAddress({ ...body.consumer.mailingAddress });
    const [
      firstName,
      lastName,
      email,
      phone,
      address,
      emailLookupHash,
      addressLookupHash,
      snapshot,
      products,
    ] = await Promise.all([
      this.crypto.encrypt(body.consumer.firstName),
      this.crypto.encrypt(body.consumer.lastName),
      this.crypto.encrypt(body.consumer.email),
      body.consumer.phone ? this.crypto.encrypt(body.consumer.phone) : Promise.resolve(undefined),
      this.crypto.encrypt(normalizedAddress),
      this.crypto.lookupHash(normalizeEmail(body.consumer.email)),
      this.crypto.lookupHash(normalizedAddress),
      this.crypto.encrypt(canonicalJson(body)),
      Promise.all(
        body.products.map(async (product): Promise<EncryptedProduct> => {
          if (!product.orderNumber) return {};
          const [orderNumber, orderNumberLookupHash] = await Promise.all([
            this.crypto.encrypt(product.orderNumber),
            this.crypto.lookupHash(normalizeOrderNumber(product.orderNumber)),
          ]);
          return { orderNumber, orderNumberLookupHash };
        }),
      ),
    ]);

    return {
      firstName,
      lastName,
      email,
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
