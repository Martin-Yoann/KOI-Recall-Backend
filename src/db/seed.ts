import 'dotenv/config';

import { eq } from 'drizzle-orm';

import { createDatabase } from './client.js';
import {
  campaignEvidenceRequirements,
  campaignLocalizations,
  campaignMessageTemplates,
  campaignProductLots,
  campaignProducts,
  campaignRemedyOptions,
  campaignVersions,
  recallCampaigns,
} from './schema/index.js';

const ids = {
  campaign: '2bdac8b0-73d8-4e38-a7e2-98fd5608788a',
  version: '85eafab1-a5bd-4d57-a697-38bce973deab',
  product: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
} as const;

async function seed() {
  if (process.env.ALLOW_SYNTHETIC_SEED !== 'true') {
    throw new Error('Synthetic seed is disabled. Set ALLOW_SYNTHETIC_SEED=true explicitly.');
  }
  if (process.env.APP_ENV === 'production') {
    throw new Error('Synthetic seed must never run against APP_ENV=production.');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

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
        { campaignVersionId: ids.version, code: 'refund', displayName: 'Refund', sortOrder: 2 },
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
  } finally {
    await handle.close();
  }
}

await seed();
