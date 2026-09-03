import 'dotenv/config';

import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { createDatabase } from './client.js';
import {
  campaignEvidenceRequirements,
  campaignLocalizations,
  campaignMessageTemplates,
  campaignProductIdentifiers,
  campaignProductLots,
  campaignProducts,
  campaignProductVariants,
  campaignRemedyOptions,
  campaignVersions,
  caseConsumers,
  caseEvents,
  caseResolutions,
  claimedProducts,
  consumerUsers,
  recallCampaigns,
  recallCases,
  staffUsers,
} from './schema/index.js';
import { hashPassword } from '../modules/staff/password.js';
import { NodeSensitiveDataCrypto } from '../platform/crypto/node-sensitive-data-crypto.js';

const ids = {
  campaign: '2bdac8b0-73d8-4e38-a7e2-98fd5608788a',
  version: '85eafab1-a5bd-4d57-a697-38bce973deab',
  product: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
  variant: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  consumerUser1: 'd0f40363-43c0-4ffc-a0df-9870f20f8f01',
  consumerUser2: 'd0f40363-43c0-4ffc-a0df-9870f20f8f02',
  staffReviewer: 'b7f42d8c-4e62-4c50-9d84-7151f3f4b001',
  caseSubmitted: '8b2f3479-2b36-4dc3-9a22-0f3ae02d5001',
  caseIssued: '8b2f3479-2b36-4dc3-9a22-0f3ae02d5002',
  caseResolved: '8b2f3479-2b36-4dc3-9a22-0f3ae02d5003',
} as const;

const staffFixture = {
  id: ids.staffReviewer,
  email: 'reviewer.demo@example.com',
  displayName: 'Demo Manager',
  role: 'MANAGER',
  password: 'Password123!@#',
} as const;

const consumerFixtures = [
  {
    userId: ids.consumerUser1,
    email: 'alex.consumer@example.com',
    displayName: 'Alex Consumer',
    password: 'Password123!@#',
    firstName: 'Alex',
    lastName: 'Consumer',
    phone: '555-010-2001',
    address: '101 Demo Street, Boston, MA 02108',
    claims: [
      {
        caseId: ids.caseSubmitted,
        claimNumber: 'KOI-DEMO-00000001',
        status: 'submitted',
        submittedAt: '2026-08-05T15:00:00.000Z',
        updatedAt: '2026-08-05T15:15:00.000Z',
        shape: 'Bear',
        flavor: 'Peach',
        lotCode: 'ML-2406-A',
        dateCode: '06/2024',
        purchaseChannel: 'online_marketplace',
        purchaseDate: '2026-07-18',
        checkResult: 'potential_match',
        requestedType: 'replacement',
        approvedType: null,
        resolutionStatus: 'requested',
        refundAmountMinor: null,
        currency: null,
        resolutionCompletedAt: null,
        events: [
          {
            id: 'ce-demo-1-submitted',
            type: 'claim.submitted',
            occurredAt: '2026-08-05T15:00:00.000Z',
            actorType: 'consumer',
          },
          {
            id: 'ce-demo-1-doc',
            type: 'document.uploaded',
            occurredAt: '2026-08-05T15:03:00.000Z',
            actorType: 'consumer',
          },
        ],
      },
      {
        caseId: ids.caseIssued,
        claimNumber: 'KOI-DEMO-00000002',
        status: 'approved',
        submittedAt: '2026-08-06T14:00:00.000Z',
        updatedAt: '2026-08-07T10:30:00.000Z',
        shape: 'Dinosaur',
        flavor: 'Strawberry',
        lotCode: 'ML-2407-B',
        dateCode: '07/2024',
        purchaseChannel: 'retail_store',
        purchaseDate: '2026-07-20',
        checkResult: 'potential_match',
        requestedType: 'refund',
        approvedType: 'refund',
        resolutionStatus: 'approved',
        refundAmountMinor: 1299,
        currency: 'USD',
        resolutionCompletedAt: null,
        events: [
          {
            id: 'ce-demo-2-submitted',
            type: 'claim.submitted',
            occurredAt: '2026-08-06T14:00:00.000Z',
            actorType: 'consumer',
          },
          {
            id: 'ce-demo-2-doc-1',
            type: 'document.uploaded',
            occurredAt: '2026-08-06T14:05:00.000Z',
            actorType: 'consumer',
          },
          {
            id: 'ce-demo-2-doc-2',
            type: 'document.uploaded',
            occurredAt: '2026-08-06T14:06:00.000Z',
            actorType: 'consumer',
          },
          {
            id: 'ce-demo-2-approved',
            type: 'resolution.approved',
            occurredAt: '2026-08-07T10:30:00.000Z',
            actorType: 'staff',
          },
        ],
      },
    ],
  },
  {
    userId: ids.consumerUser2,
    email: 'jamie.consumer@example.com',
    displayName: 'Jamie Consumer',
    password: 'Password123!@#',
    firstName: 'Jamie',
    lastName: 'Consumer',
    phone: '555-010-2002',
    address: '202 Sample Avenue, Austin, TX 78701',
    claims: [
      {
        caseId: ids.caseResolved,
        claimNumber: 'KOI-DEMO-00000003',
        status: 'closed',
        submittedAt: '2026-08-01T12:00:00.000Z',
        updatedAt: '2026-08-09T09:45:00.000Z',
        shape: 'Heart',
        flavor: 'Peach',
        lotCode: 'ML-2408-C',
        dateCode: '08/2024',
        purchaseChannel: 'grocery_store',
        purchaseDate: '2026-07-11',
        checkResult: 'potential_match',
        requestedType: 'replacement',
        approvedType: 'replacement',
        resolutionStatus: 'externally_completed',
        refundAmountMinor: null,
        currency: null,
        resolutionCompletedAt: '2026-08-09T09:45:00.000Z',
        events: [
          {
            id: 'ce-demo-3-submitted',
            type: 'claim.submitted',
            occurredAt: '2026-08-01T12:00:00.000Z',
            actorType: 'consumer',
          },
          {
            id: 'ce-demo-3-doc',
            type: 'document.uploaded',
            occurredAt: '2026-08-01T12:04:00.000Z',
            actorType: 'consumer',
          },
          {
            id: 'ce-demo-3-approved',
            type: 'resolution.approved',
            occurredAt: '2026-08-03T11:00:00.000Z',
            actorType: 'staff',
          },
          {
            id: 'ce-demo-3-completed',
            type: 'resolution.completed',
            occurredAt: '2026-08-09T09:45:00.000Z',
            actorType: 'staff',
          },
        ],
      },
    ],
  },
] as const;

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

async function seed() {
  if (process.env.ALLOW_SYNTHETIC_SEED !== 'true') {
    throw new Error('Synthetic seed is disabled. Set ALLOW_SYNTHETIC_SEED=true explicitly.');
  }
  if (process.env.APP_ENV === 'production') {
    throw new Error('Synthetic seed must never run against APP_ENV=production.');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const fieldKey = process.env.FIELD_ENCRYPTION_KEY;
  const hashPepper = process.env.HASH_PEPPER;
  if (!fieldKey || !hashPepper) {
    throw new Error('FIELD_ENCRYPTION_KEY and HASH_PEPPER are required.');
  }

  const crypto = new NodeSensitiveDataCrypto(fieldKey, hashPepper);
  const handle = createDatabase(process.env.DATABASE_URL);
  const { db } = handle;

  try {
    await db
      .insert(recallCampaigns)
      .values({
        id: ids.campaign,
        slug: 'music-lollipop-demo-2026',
        code: 'ML-DEMO-2026',
        status: 'active',
        defaultLocale: 'en-US',
        isTestData: true,
        launchAt: new Date('2026-08-04T00:00:00.000Z'),
      })
      .onConflictDoNothing();

    await db
      .insert(campaignVersions)
      .values({
        id: ids.version,
        campaignId: ids.campaign,
        versionNumber: 1,
        status: 'published',
        publishedAt: new Date('2026-08-04T00:00:00.000Z'),
        // Claim submission rejects a version without this (consent freshness
        // check); the fixture consents carry the same textVersion.
        privacyNoticeVersion: '2026-08-04',
        privacyNoticeUrl: 'https://example.com/privacy-notice',
      })
      .onConflictDoNothing();

    await db
      .update(recallCampaigns)
      .set({ publishedVersionId: ids.version })
      .where(eq(recallCampaigns.id, ids.campaign));

    await db
      .insert(campaignLocalizations)
      .values({
        campaignVersionId: ids.version,
        locale: 'en-US',
        title: 'Music Lollipop Safety Recall',
        summary: 'Fictional test content for the KOI Phase 1 service skeleton.',
        hazard: 'Fictional component-separation hazard.',
        immediateAction:
          'Stop using a potentially affected product until its lot code has been checked.',
        remedySummary: 'Replacement or refund after manual review.',
        supportEmail: 'demo-support@example.invalid',
        supportPhone: '(555) 010-2042',
        supportHours: 'Monday-Friday, 9:00 a.m.-5:00 p.m. ET',
        faq: [],
      })
      .onConflictDoNothing();

    await db
      .insert(campaignProducts)
      .values({
        id: ids.product,
        campaignVersionId: ids.version,
        sku: 'MUSIC-LOLLIPOP-DEMO-18G',
        brand: 'Candy Master',
        name: 'Music Lollipop',
        attributes: {
          weight: '18g',
          flavors: ['Peach', 'Strawberry'],
          shapes: ['Bear', 'Dinosaur', 'Strawberry', 'Heart'],
        },
      })
      .onConflictDoNothing();

    // ADR-0001 dual-write: alongside the legacy flat attributes above, populate
    // the new variant + identifier structure so both old and new read paths
    // resolve the same demo product. The SKU is mirrored as an identifier and a
    // demo UPC is added so the identifier lookup path has realistic data.
    await db
      .insert(campaignProductVariants)
      .values({
        id: ids.variant,
        campaignProductId: ids.product,
        model: 'ML-DEMO',
        style: '18g',
        attributes: { flavors: ['Peach', 'Strawberry'], shapes: ['Bear', 'Dinosaur'] },
      })
      .onConflictDoNothing();

    await db
      .insert(campaignProductIdentifiers)
      .values([
        {
          variantId: ids.variant,
          identifierType: 'sku',
          rawValue: 'MUSIC-LOLLIPOP-DEMO-18G',
          normalizedValue: 'music-lollipop-demo-18g',
        },
        {
          variantId: ids.variant,
          identifierType: 'unit_upc',
          rawValue: '0123456789012',
          normalizedValue: '0123456789012',
        },
      ])
      .onConflictDoNothing();

    await db
      .insert(campaignProductLots)
      .values([
        {
          campaignProductId: ids.product,
          lotCode: 'ML-2406-A',
          dateCode: '06/2024',
          attributes: {},
        },
        {
          campaignProductId: ids.product,
          lotCode: 'ML-2407-B',
          dateCode: '07/2024',
          attributes: {},
        },
        {
          campaignProductId: ids.product,
          lotCode: 'ML-2408-C',
          dateCode: '08/2024',
          attributes: {},
        },
      ])
      .onConflictDoNothing();

    await db
      .insert(campaignRemedyOptions)
      .values([
        {
          campaignVersionId: ids.version,
          code: 'replacement',
          displayName: 'Replacement',
          sortOrder: 1,
        },
        {
          campaignVersionId: ids.version,
          code: 'refund',
          displayName: 'Refund',
          sortOrder: 2,
        },
      ])
      .onConflictDoNothing();

    await db
      .insert(campaignEvidenceRequirements)
      .values([
        {
          campaignVersionId: ids.version,
          category: 'product_photo',
          required: true,
          minimumFiles: 1,
          maximumFiles: 5,
          allowedMimeTypes: ['image/jpeg', 'image/png', 'image/heic'],
          maximumFileSizeBytes: 10_485_760,
          instructions: 'Upload a clear product and lot-label photo.',
        },
        {
          campaignVersionId: ids.version,
          category: 'proof_of_purchase',
          required: true,
          minimumFiles: 1,
          maximumFiles: 3,
          allowedMimeTypes: ['image/jpeg', 'image/png', 'image/heic', 'application/pdf'],
          maximumFileSizeBytes: 10_485_760,
          instructions: 'Upload a receipt, invoice, or order screenshot.',
        },
        {
          campaignVersionId: ids.version,
          category: 'incident_evidence',
          required: false,
          minimumFiles: 0,
          maximumFiles: 5,
          allowedMimeTypes: ['image/jpeg', 'image/png', 'image/heic', 'application/pdf'],
          maximumFileSizeBytes: 10_485_760,
          instructions: 'Optional supporting evidence for an incident or injury.',
        },
      ])
      .onConflictDoNothing();

    await db
      .insert(campaignMessageTemplates)
      .values({
        campaignVersionId: ids.version,
        locale: 'en-US',
        templateType: 'claim_confirmation',
        version: 1,
        subject: 'We received your recall claim {{caseReference}}',
        htmlBody: '<p>We received your recall claim. Your reference is {{caseReference}}.</p>',
        textBody: 'We received your recall claim. Your reference is {{caseReference}}.',
      })
      .onConflictDoNothing();

    const remedyOptions = await db
      .select({ id: campaignRemedyOptions.id, code: campaignRemedyOptions.code })
      .from(campaignRemedyOptions)
      .where(eq(campaignRemedyOptions.campaignVersionId, ids.version));
    const remedyOptionIds = Object.fromEntries(
      remedyOptions.map((option) => [option.code, option.id]),
    );

    const staffEmailLookupHash = await crypto.lookupHash(staffFixture.email.toLowerCase());
    const staffPasswordHash = await hashPassword(staffFixture.password);
    await db
      .insert(staffUsers)
      .values({
        id: staffFixture.id,
        email: staffFixture.email,
        emailLookupHash: staffEmailLookupHash,
        displayName: staffFixture.displayName,
        role: staffFixture.role,
        passwordHash: staffPasswordHash,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: staffUsers.id,
        set: {
          email: staffFixture.email,
          emailLookupHash: staffEmailLookupHash,
          displayName: staffFixture.displayName,
          role: staffFixture.role,
          passwordHash: staffPasswordHash,
          status: 'active',
          updatedAt: new Date(),
        },
      });

    for (const fixture of consumerFixtures) {
      const passwordHash = await hashPassword(fixture.password);
      const emailLookupHash = await crypto.lookupHash(fixture.email.toLowerCase());
      const [
        firstNameEncrypted,
        lastNameEncrypted,
        emailEncrypted,
        phoneEncrypted,
        addressEncrypted,
      ] = await Promise.all([
        crypto.encrypt(fixture.firstName),
        crypto.encrypt(fixture.lastName),
        crypto.encrypt(fixture.email),
        crypto.encrypt(fixture.phone),
        crypto.encrypt(fixture.address),
      ]);
      const addressLookupHash = await crypto.lookupHash(fixture.address.trim().toLowerCase());

      await db
        .insert(consumerUsers)
        .values({
          id: fixture.userId,
          email: fixture.email,
          emailLookupHash,
          displayName: fixture.displayName,
          passwordHash,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: consumerUsers.id,
          set: {
            email: fixture.email,
            emailLookupHash,
            displayName: fixture.displayName,
            passwordHash,
            status: 'active',
            updatedAt: new Date(),
          },
        });
      for (const claim of fixture.claims) {
        await db
          .insert(recallCases)
          .values({
            id: claim.caseId,
            publicReference: claim.claimNumber,
            campaignId: ids.campaign,
            campaignVersionId: ids.version,
            locale: 'en-US',
            subtype: 'standard',
            status: claim.status,
            submittedAt: new Date(claim.submittedAt),
            createdAt: new Date(claim.submittedAt),
            updatedAt: new Date(claim.updatedAt),
          })
          .onConflictDoUpdate({
            target: recallCases.id,
            set: {
              publicReference: claim.claimNumber,
              status: claim.status,
              updatedAt: new Date(claim.updatedAt),
            },
          });

        await db
          .insert(caseConsumers)
          .values({
            caseId: claim.caseId,
            keyVersion: firstNameEncrypted.keyVersion,
            firstNameEncrypted: firstNameEncrypted.value,
            lastNameEncrypted: lastNameEncrypted.value,
            emailEncrypted: emailEncrypted.value,
            emailLookupHash,
            phoneEncrypted: phoneEncrypted.value,
            addressEncrypted: addressEncrypted.value,
            addressLookupHash,
            countryCode: 'US',
            createdAt: new Date(claim.submittedAt),
            updatedAt: new Date(claim.updatedAt),
          })
          .onConflictDoUpdate({
            target: caseConsumers.caseId,
            set: {
              keyVersion: firstNameEncrypted.keyVersion,
              firstNameEncrypted: firstNameEncrypted.value,
              lastNameEncrypted: lastNameEncrypted.value,
              emailEncrypted: emailEncrypted.value,
              emailLookupHash,
              phoneEncrypted: phoneEncrypted.value,
              addressEncrypted: addressEncrypted.value,
              addressLookupHash,
              updatedAt: new Date(claim.updatedAt),
            },
          });

        // claimed_products currently has no unique constraint on case_id, so
        // make the seed idempotent by replacing any prior synthetic row first.
        await db.delete(claimedProducts).where(eq(claimedProducts.caseId, claim.caseId));

        await db.insert(claimedProducts).values({
          caseId: claim.caseId,
          campaignProductId: ids.product,
          quantity: 1,
          shape: claim.shape,
          flavor: claim.flavor,
          lotCode: claim.lotCode,
          dateCode: claim.dateCode,
          purchaseChannel: claim.purchaseChannel,
          purchaseDate: claim.purchaseDate,
          checkResult: claim.checkResult,
          identificationMode: 'product_identifiers',
          matchedVariantIds: [ids.variant],
          reasonCodes: ['demo_seed'],
          inputSnapshot: {
            lotCode: claim.lotCode,
            dateCode: claim.dateCode,
            source: 'synthetic-seed',
          },
          createdAt: new Date(claim.submittedAt),
          updatedAt: new Date(claim.updatedAt),
        });

        await db
          .insert(caseResolutions)
          .values({
            caseId: claim.caseId,
            requestedType: claim.requestedType,
            requestedRemedyOptionId: remedyOptionIds[claim.requestedType],
            approvedType: claim.approvedType,
            status: claim.resolutionStatus,
            refundAmountMinor: claim.refundAmountMinor,
            currency: claim.currency,
            approvedByStaffUserId: claim.approvedType ? staffFixture.id : null,
            approvedAt: claim.approvedType ? new Date(claim.updatedAt) : null,
            externalReference: claim.approvedType
              ? `seed-${claim.claimNumber.toLowerCase()}`
              : null,
            completedByStaffUserId: claim.resolutionCompletedAt ? staffFixture.id : null,
            completedAt: claim.resolutionCompletedAt ? new Date(claim.resolutionCompletedAt) : null,
            createdAt: new Date(claim.submittedAt),
            updatedAt: new Date(claim.updatedAt),
          })
          .onConflictDoUpdate({
            target: caseResolutions.caseId,
            set: {
              requestedType: claim.requestedType,
              requestedRemedyOptionId: remedyOptionIds[claim.requestedType],
              approvedType: claim.approvedType,
              status: claim.resolutionStatus,
              refundAmountMinor: claim.refundAmountMinor,
              currency: claim.currency,
              approvedByStaffUserId: claim.approvedType ? staffFixture.id : null,
              approvedAt: claim.approvedType ? new Date(claim.updatedAt) : null,
              externalReference: claim.approvedType
                ? `seed-${claim.claimNumber.toLowerCase()}`
                : null,
              completedByStaffUserId: claim.resolutionCompletedAt ? staffFixture.id : null,
              completedAt: claim.resolutionCompletedAt
                ? new Date(claim.resolutionCompletedAt)
                : null,
              updatedAt: new Date(claim.updatedAt),
            },
          });

        for (const event of claim.events) {
          await db
            .insert(caseEvents)
            .values({
              id: `${sha256hex(`${claim.caseId}:${event.id}`).slice(0, 8)}-0000-4000-8000-000000000000`,
              caseId: claim.caseId,
              eventType: event.type,
              actorType: event.actorType,
              data: { source: 'synthetic-seed', eventKey: event.id },
              occurredAt: new Date(event.occurredAt),
            })
            .onConflictDoNothing();
        }
      }
    }
  } finally {
    await handle.close();
  }
}

await seed();
