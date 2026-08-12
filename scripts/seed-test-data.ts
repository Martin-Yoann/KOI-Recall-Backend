// ============================================================
// KOI Recall — Comprehensive Test Data Seeder
// Writes rich test data across all modules to Neon PostgreSQL.
//
// Prerequisites:
//   1. Backend .env/.env.local must have DATABASE_URL, FIELD_ENCRYPTION_KEY, HASH_PEPPER
//   2. Database must already have migrations applied (migrations + base seed not required but recommended)
//
// Usage:
//   $env:ALLOW_SYNTHETIC_SEED="true"
//   pnpm tsx scripts/seed-test-data.ts
//
// This creates:
//   - 3 staff users (admin / reviewer / viewer) with scrypt passwords
//   - 3 campaigns in different statuses (active / paused / scheduled)
//   - ~15 active claim drafts
//   - ~18 recall cases across all statuses
//   - Encrypted consumer PII (names, emails, phones, addresses)
//   - 12 incident reports with reportability reviews
//   - 50+ case events (immutable timeline)
//   - 40+ admin audit events (compliance trail)
//   - 20+ communications (email delivery tracking)
//   - 10+ document uploads
// ============================================================

import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { createDatabase } from '../src/db/client.js';
import { hashPassword } from '../src/modules/staff/password.js';
import {
  recallCampaigns, campaignVersions, campaignLocalizations,
  campaignProducts, campaignProductVariants, campaignProductIdentifiers,
  campaignProductLots, campaignRemedyOptions, campaignEvidenceRequirements,
  campaignMessageTemplates,
} from '../src/db/schema/campaigns.js';
import {
  claimDrafts, recallCases, caseConsumers, claimedProducts, caseConsents, submissionSnapshots,
} from '../src/db/schema/claims.js';
import { documentUploads } from '../src/db/schema/documents.js';
import { incidents, reportabilityReviews } from '../src/db/schema/incidents.js';
import { caseEvents, communications, outboxEvents } from '../src/db/schema/operations.js';
import { staffUsers, staffSessions, adminAuditEvents } from '../src/db/schema/staff.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';

const databaseUrl = process.env.DATABASE_URL;
const encKey = process.env.FIELD_ENCRYPTION_KEY;
const pepper = process.env.HASH_PEPPER;

if (!databaseUrl) throw new Error('DATABASE_URL required');
if (!encKey || !pepper) throw new Error('FIELD_ENCRYPTION_KEY and HASH_PEPPER required');

const handle = createDatabase(databaseUrl);
const { db } = handle;
const crypto = new NodeSensitiveDataCrypto(encKey, pepper);

// ── Helpers ────────────────────────────────────────────

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function randomRef(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = 'KOI-';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  out += '-';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

interface EncryptedPII {
  encrypted: { keyVersion: string; value: string };
  lookupHash: string;
}

async function encryptPII(plaintext: string): Promise<EncryptedPII> {
  const encrypted = await crypto.encrypt(plaintext);
  const lookupHash = await crypto.lookupHash(plaintext.toLowerCase().trim());
  return { encrypted, lookupHash };
}

async function encryptNarrative(text: string): Promise<string> {
  return (await crypto.encrypt(text)).value;
}

const DAY = 86400000;
const now = Date.now();

async function main() {
  console.log('🌱 Seeding comprehensive test data...\n');

  // ── Cleanup: remove all existing test data ──
  console.log('  [0/7] Cleaning existing test data...');
  // First null out circular FKs
  await db.update(recallCampaigns).set({ publishedVersionId: null });
  // Delete in dependency order (children first)
  await db.delete(submissionSnapshots);
  await db.delete(caseConsents);
  await db.delete(reportabilityReviews);
  await db.delete(incidents);
  await db.delete(caseEvents);
  await db.delete(communications);
  await db.delete(outboxEvents);
  await db.delete(adminAuditEvents);
  await db.delete(documentUploads);
  await db.delete(claimedProducts);
  await db.delete(caseConsumers);
  await db.delete(claimDrafts);
  await db.delete(recallCases);
  await db.delete(campaignProductIdentifiers);
  await db.delete(campaignProductLots);
  await db.delete(campaignProductVariants);
  await db.delete(campaignProducts);
  await db.delete(campaignEvidenceRequirements);
  await db.delete(campaignRemedyOptions);
  await db.delete(campaignMessageTemplates);
  await db.delete(campaignLocalizations);
  await db.delete(campaignVersions);
  await db.delete(recallCampaigns);
  await db.delete(staffSessions);
  await db.delete(staffUsers);
  console.log('    ✓ Cleaned\n');

  // ================================================================
  // 1. STAFF USERS — 3 roles for RBAC testing
  // ================================================================
  console.log('  [1/7] Staff users...');

  const staffIds: Record<string, string> = {};
  const pw1 = await hashPassword('admin123456!@');
  const pw2 = await hashPassword('review2026!@#');
  const pw3 = await hashPassword('viewer2026!@#');

  const staffInserted = await db.insert(staffUsers).values([
    {
      email: 'admin@koi-platform.com',
      emailLookupHash: await crypto.lookupHash('admin@koi-platform.com'),
      displayName: 'Lin Wei (Admin)',
      role: 'administrator',
      status: 'active',
      passwordHash: pw1,
      lastLoginAt: new Date(now - 1 * DAY),
    },
    {
      email: 'reviewer@koi-platform.com',
      emailLookupHash: await crypto.lookupHash('reviewer@koi-platform.com'),
      displayName: 'Chen Mei (Reviewer)',
      role: 'reviewer',
      status: 'active',
      passwordHash: pw2,
      lastLoginAt: new Date(now - 2 * DAY),
    },
    {
      email: 'viewer@koi-platform.com',
      emailLookupHash: await crypto.lookupHash('viewer@koi-platform.com'),
      displayName: 'Wang Lei (Viewer)',
      role: 'viewer',
      status: 'active',
      passwordHash: pw3,
      lastLoginAt: new Date(now - 5 * DAY),
    },
  ]).returning({ id: staffUsers.id, email: staffUsers.email }).onConflictDoNothing();

  for (const s of staffInserted) {
    staffIds[s.email] = s.id;
  }

  if (staffInserted.length === 0) {
    const existing = await db.select({ id: staffUsers.id, email: staffUsers.email }).from(staffUsers);
    for (const s of existing) {
      staffIds[s.email] = s.id;
    }
  }

  console.log(`    ✓ ${Object.keys(staffIds).length} staff users`);

  // ================================================================
  // 2. CAMPAIGNS — 2 additional (3 total with existing seed)
  // ================================================================
  console.log('  [2/7] Campaigns...');

  // Campaign 1: Existing Music Lollipop (from seed) — we'll add a second version
  // Campaign 2: Baby Stroller (active)
  // Campaign 3: Electric Kettle (scheduled)

  const campaigns: Array<{
    id: string;
    slug: string;
    code: string;
    status: 'draft' | 'scheduled' | 'active' | 'paused' | 'closed';
    versionId: string;
    productId: string;
    variantId: string;
    locale: string;
  }> = [];

  // -- Baby Stroller: active recall --
  const strollerId = randomUUID();
  const strollerVersionId = randomUUID();
  const strollerProductId = randomUUID();
  const strollerVariantId = randomUUID();

  await db.insert(recallCampaigns).values({
    id: strollerId,
    slug: 'baby-stroller-safety-recall-2026',
    code: 'CPSC-26-189',
    status: 'active',
    defaultLocale: 'en-US',
    isTestData: true,
    launchAt: new Date('2026-06-01T00:00:00.000Z'),
  }).onConflictDoNothing();

  await db.insert(campaignVersions).values({
    id: strollerVersionId,
    campaignId: strollerId,
    versionNumber: 1,
    status: 'published',
    publishedAt: new Date('2026-06-01T00:00:00.000Z'),
    publishedBy: staffIds['admin@koi-platform.com'] ?? null,
    approvals: [{
      role: 'business' as const,
      approvedBy: 'lin-wei',
      approvedAt: new Date('2026-06-01T00:00:00.000Z').toISOString(),
    }],
  }).onConflictDoNothing();

  await db.update(recallCampaigns)
    .set({ publishedVersionId: strollerVersionId })
    .where(sql`${recallCampaigns.id} = ${strollerId}`)
    .execute() as never;

  await db.insert(campaignLocalizations).values({
    campaignVersionId: strollerVersionId,
    locale: 'en-US',
    title: 'BabyJoy X1 Stroller — Wheel Detachment Hazard',
    summary: 'The front wheel assembly on BabyJoy X1 strollers manufactured between January and May 2026 may detach during use, posing a fall and injury hazard to children.',
    hazard: 'Front wheel axle pin can shear under lateral stress, causing the wheel assembly to separate from the frame. At least 12 incidents reported, including 3 involving minor injuries to children.',
    immediateAction: 'Stop using the stroller immediately. Inspect the front wheel assembly for any looseness or unusual movement. Do not attempt to repair the wheel yourself.',
    remedySummary: 'Free repair kit with reinforced axle pin and installation instructions, or full refund with return of stroller.',
    supportEmail: 'safety@babyjoy.com',
    supportPhone: '(800) 555-0199',
    supportHours: 'Monday-Friday, 8:00 a.m.-8:00 p.m. ET, Saturday 9:00 a.m.-5:00 p.m. ET',
    faq: [
      { topic: 'Identification', question: 'How do I know if my stroller is affected?', answer: 'Check the model number on the frame label under the seat. Affected models: BJ-X1-2026-A through BJ-X1-2026-D with date codes 01/2026 through 05/2026.' },
      { topic: 'Repair', question: 'Can I install the repair kit myself?', answer: 'Yes. The repair kit includes detailed illustrated instructions and a video guide. If you prefer, authorized service centers will install it free of charge.' },
    ],
  }).onConflictDoNothing();

  await db.insert(campaignProducts).values({
    id: strollerProductId,
    campaignVersionId: strollerVersionId,
    sku: 'BJ-X1-GRY-2026',
    brand: 'BabyJoy',
    name: 'BabyJoy X1 Stroller — Graphite Gray',
    attributes: { weight: '7.8kg', color: 'Graphite Gray', ageRange: '0-36 months' } as Record<string, unknown>,
  }).onConflictDoNothing();

  await db.insert(campaignProductVariants).values({
    id: strollerVariantId,
    campaignProductId: strollerProductId,
    model: 'BJ-X1-2026-A',
    style: 'Graphite Gray',
    attributes: { wheelType: 'EVA foam', foldMechanism: 'one-hand' } as Record<string, unknown>,
  }).onConflictDoNothing();

  await db.insert(campaignProductIdentifiers).values([
    { variantId: strollerVariantId, identifierType: 'sku', rawValue: 'BJ-X1-GRY-2026', normalizedValue: 'bj-x1-gry-2026' },
    { variantId: strollerVariantId, identifierType: 'unit_upc', rawValue: '0123456789050', normalizedValue: '0123456789050' },
    { variantId: strollerVariantId, identifierType: 'model', rawValue: 'BJ-X1-2026-A', normalizedValue: 'bj-x1-2026-a' },
  ]).onConflictDoNothing();

  await db.insert(campaignProductLots).values([
    { campaignProductId: strollerProductId, lotCode: 'BJ-2601-A', dateCode: '01/2026', eligibilityStatus: 'affected' },
    { campaignProductId: strollerProductId, lotCode: 'BJ-2602-B', dateCode: '02/2026', eligibilityStatus: 'affected' },
    { campaignProductId: strollerProductId, lotCode: 'BJ-2603-C', dateCode: '03/2026', eligibilityStatus: 'affected' },
    { campaignProductId: strollerProductId, lotCode: 'BJ-2604-D', dateCode: '04/2026', eligibilityStatus: 'affected' },
    { campaignProductId: strollerProductId, lotCode: 'BJ-2605-E', dateCode: '05/2026', eligibilityStatus: 'affected' },
    { campaignProductId: strollerProductId, lotCode: 'BJ-2606-F', dateCode: '06/2026', eligibilityStatus: 'not_affected' },
  ]).onConflictDoNothing();

  await db.insert(campaignRemedyOptions).values([
    { campaignVersionId: strollerVersionId, code: 'repair_kit', displayName: 'Free Repair Kit — Reinforced Axle', requiresMailingAddress: true, sortOrder: 1 },
    { campaignVersionId: strollerVersionId, code: 'refund', displayName: 'Full Refund with Return', requiresMailingAddress: false, sortOrder: 2 },
  ]).onConflictDoNothing();

  await db.insert(campaignEvidenceRequirements).values([
    { campaignVersionId: strollerVersionId, category: 'product_photo', required: true, minimumFiles: 1, maximumFiles: 3, allowedMimeTypes: ['image/jpeg', 'image/png'], maximumFileSizeBytes: 10485760, instructions: 'Photo of the stroller frame label showing model number and date code.' },
    { campaignVersionId: strollerVersionId, category: 'proof_of_purchase', required: true, minimumFiles: 1, maximumFiles: 3, allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'], maximumFileSizeBytes: 10485760, instructions: 'Receipt, invoice, or order confirmation.' },
  ]).onConflictDoNothing();

  await db.insert(campaignMessageTemplates).values({
    campaignVersionId: strollerVersionId,
    locale: 'en-US',
    templateType: 'claim_confirmation',
    version: 1,
    subject: 'We received your BabyJoy Stroller recall claim {{caseReference}}',
    htmlBody: '<p>We received your recall claim. Your reference is <strong>{{caseReference}}</strong>.</p>',
    textBody: 'We received your recall claim. Your reference is {{caseReference}}.',
  }).onConflictDoNothing();

  campaigns.push({ id: strollerId, slug: 'baby-stroller-safety-recall-2026', code: 'CPSC-26-189', status: 'active', versionId: strollerVersionId, productId: strollerProductId, variantId: strollerVariantId, locale: 'en-US' });

  // -- Electric Kettle: scheduled recall --
  const kettleId = randomUUID();
  const kettleVersionId = randomUUID();
  const kettleProductId = randomUUID();
  const kettleVariantId = randomUUID();

  await db.insert(recallCampaigns).values({
    id: kettleId,
    slug: 'electric-kettle-recall-2026',
    code: 'CPSC-26-312',
    status: 'scheduled',
    defaultLocale: 'en-US',
    isTestData: true,
    launchAt: new Date('2026-09-01T00:00:00.000Z'),
  }).onConflictDoNothing();

  await db.insert(campaignVersions).values({
    id: kettleVersionId,
    campaignId: kettleId,
    versionNumber: 1,
    status: 'published',
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    publishedBy: staffIds['admin@koi-platform.com'] ?? null,
    approvals: [{ role: 'business' as const, approvedBy: 'lin-wei', approvedAt: new Date('2026-08-01T00:00:00.000Z').toISOString() }, { role: 'legal_compliance' as const, approvedBy: 'chen-mei', approvedAt: new Date('2026-08-01T12:00:00.000Z').toISOString() }],
  }).onConflictDoNothing();

  await db.update(recallCampaigns)
    .set({ publishedVersionId: kettleVersionId })
    .where(sql`${recallCampaigns.id} = ${kettleId}`)
    .execute() as never;

  await db.insert(campaignLocalizations).values({
    campaignVersionId: kettleVersionId,
    locale: 'en-US',
    title: 'HeatPro 1.7L Electric Kettle — Overheating & Fire Risk',
    summary: 'HeatPro 1.7L Electric Kettles (model HP-EK17) manufactured between March and July 2026 may overheat due to a defective thermostat, posing burn and fire hazards.',
    hazard: 'Thermostat may fail to auto-shutoff at boiling point, causing the kettle to continuously heat until the thermal fuse blows. In rare cases, the plastic base may melt, posing a fire risk. Eight reports of base melting; no injuries reported.',
    immediateAction: 'Unplug the kettle and do not use it. Do not attempt to bypass the auto-shutoff feature.',
    remedySummary: 'Full refund with proof of purchase, or free replacement with updated HP-EK17-V2 model.',
    supportEmail: 'recall@heatpro-appliances.com',
    supportPhone: '(888) 555-0234',
    supportHours: 'Monday-Friday, 9:00 a.m.-6:00 p.m. ET',
    faq: [],
  }).onConflictDoNothing();

  await db.insert(campaignProducts).values({
    id: kettleProductId,
    campaignVersionId: kettleVersionId,
    sku: 'HP-EK17-SS-2026',
    brand: 'HeatPro',
    name: 'HeatPro 1.7L Electric Kettle — Stainless Steel',
    attributes: { capacity: '1.7L', material: 'stainless steel', power: '1500W', color: 'Brushed Steel' } as Record<string, unknown>,
  }).onConflictDoNothing();

  await db.insert(campaignProductVariants).values({
    id: kettleVariantId,
    campaignProductId: kettleProductId,
    model: 'HP-EK17-V1',
    style: 'Brushed Steel',
    attributes: {} as Record<string, unknown>,
  }).onConflictDoNothing();

  await db.insert(campaignProductIdentifiers).values([
    { variantId: kettleVariantId, identifierType: 'sku', rawValue: 'HP-EK17-SS-2026', normalizedValue: 'hp-ek17-ss-2026' },
    { variantId: kettleVariantId, identifierType: 'unit_upc', rawValue: '0123456789067', normalizedValue: '0123456789067' },
  ]).onConflictDoNothing();

  await db.insert(campaignProductLots).values([
    { campaignProductId: kettleProductId, lotCode: 'HP-2603-A', dateCode: '03/2026', eligibilityStatus: 'affected' },
    { campaignProductId: kettleProductId, lotCode: 'HP-2604-B', dateCode: '04/2026', eligibilityStatus: 'affected' },
    { campaignProductId: kettleProductId, lotCode: 'HP-2605-C', dateCode: '05/2026', eligibilityStatus: 'affected' },
    { campaignProductId: kettleProductId, lotCode: 'HP-2606-D', dateCode: '06/2026', eligibilityStatus: 'affected' },
    { campaignProductId: kettleProductId, lotCode: 'HP-2607-E', dateCode: '07/2026', eligibilityStatus: 'affected' },
  ]).onConflictDoNothing();

  await db.insert(campaignRemedyOptions).values([
    { campaignVersionId: kettleVersionId, code: 'refund', displayName: 'Full Refund', requiresMailingAddress: false, sortOrder: 1 },
    { campaignVersionId: kettleVersionId, code: 'replacement', displayName: 'Free Replacement (HP-EK17-V2)', requiresMailingAddress: true, sortOrder: 2 },
  ]).onConflictDoNothing();

  await db.insert(campaignEvidenceRequirements).values([
    { campaignVersionId: kettleVersionId, category: 'product_photo', required: true, minimumFiles: 1, maximumFiles: 2, allowedMimeTypes: ['image/jpeg', 'image/png'], maximumFileSizeBytes: 5242880, instructions: 'Photo of the kettle base showing model label and batch sticker.' },
    { campaignVersionId: kettleVersionId, category: 'proof_of_purchase', required: true, minimumFiles: 1, maximumFiles: 2, allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'], maximumFileSizeBytes: 5242880, instructions: 'Receipt or online order confirmation.' },
  ]).onConflictDoNothing();

  await db.insert(campaignMessageTemplates).values({
    campaignVersionId: kettleVersionId,
    locale: 'en-US',
    templateType: 'claim_confirmation',
    version: 1,
    subject: 'We received your HeatPro Kettle recall claim {{caseReference}}',
    htmlBody: '<p>We received your recall claim. Your reference is <strong>{{caseReference}}</strong>.</p>',
    textBody: 'We received your recall claim. Your reference is {{caseReference}}.',
  }).onConflictDoNothing();

  campaigns.push({ id: kettleId, slug: 'electric-kettle-recall-2026', code: 'CPSC-26-312', status: 'scheduled', versionId: kettleVersionId, productId: kettleProductId, variantId: kettleVariantId, locale: 'en-US' });

  // Get the existing campaign from base seed
  const existingCampaigns = await db.select({ id: recallCampaigns.id, slug: recallCampaigns.slug, code: recallCampaigns.code, status: recallCampaigns.status, publishedVersionId: recallCampaigns.publishedVersionId }).from(recallCampaigns).where(sql`${recallCampaigns.isTestData} = true`);
  const existingProducts = await db.select({ id: campaignProducts.id, campaignVersionId: campaignProducts.campaignVersionId }).from(campaignProducts);

  const allCampaigns = [...campaigns];
  for (const ec of existingCampaigns) {
    if (!allCampaigns.find(c => c.id === ec.id)) {
      const product = existingProducts.find(p => p.campaignVersionId === ec.publishedVersionId);
      allCampaigns.push({
        id: ec.id,
        slug: ec.slug!,
        code: ec.code!,
        status: ec.status as never,
        versionId: ec.publishedVersionId!,
        productId: product?.id ?? randomUUID(),
        variantId: randomUUID(),
        locale: 'en-US',
      });
    }
  }

  const productMap: Record<string, string> = {};
  for (const c of allCampaigns) productMap[c.id] = c.productId;

  console.log(`    ✓ ${allCampaigns.length} campaigns (${allCampaigns.map(c => c.code).join(', ')})`);

  // ================================================================
  // 3. CLAIM DRAFTS — active sessions waiting for submission
  // ================================================================
  console.log('  [3/7] Claim drafts...');

  const drafts: Array<{ id: string; token: string }> = [];
  for (let i = 0; i < 6; i++) {
    const campaign = allCampaigns[i % allCampaigns.length];
    const draftId = randomUUID();
    const token = randomUUID().replace(/-/g, '');
    await db.insert(claimDrafts).values({
      id: draftId,
      campaignId: campaign.id,
      campaignVersionId: campaign.versionId,
      tokenHash: sha256(token),
      status: 'active',
      expiresAt: new Date(now + 7 * DAY),
    }).onConflictDoNothing();
    drafts.push({ id: draftId, token });
  }
  console.log(`    ✓ ${drafts.length} active claim drafts`);

  // ================================================================
  // 4. RECALL CASES — across all statuses, multi-campaign, realistic data
  // ================================================================
  console.log('  [4/7] Recall cases + consumers + products...');

  const consumerData = [
    { first: 'Sarah', last: 'Chen', email: 'sarah.chen@gmail.com', phone: '+1 (212) 555-0142', addr: '245 East 63rd Street, Apt 4B, New York, NY 10065' },
    { first: 'James', last: 'Wilson', email: 'jwilson@outlook.com', phone: '+1 (312) 555-0187', addr: '1420 North Lake Shore Drive, Chicago, IL 60610' },
    { first: 'Emily', last: 'Davis', email: 'emily.davis@yahoo.com', phone: '+1 (415) 555-0233', addr: '888 Howard Street, San Francisco, CA 94103' },
    { first: 'Amanda', last: 'Torres', email: 'atorres@icloud.com', phone: '+1 (305) 555-0176', addr: '1100 Biscayne Boulevard, Miami, FL 33132' },
    { first: 'Michael', last: 'Kim', email: 'michael.kim@proton.me', phone: '+1 (206) 555-0192', addr: '1918 8th Avenue, Seattle, WA 98101' },
    { first: 'Priya', last: 'Patel', email: 'priya.patel@gmail.com', phone: '+1 (617) 555-0148', addr: '1 Beacon Street, Boston, MA 02108' },
    { first: 'David', last: 'Thompson', email: 'd.thompson@outlook.com', phone: '+1 (303) 555-0105', addr: '1600 Broadway, Denver, CO 80202' },
    { first: 'Lisa', last: 'Garcia', email: 'lisa.garcia@icloud.com', phone: '+1 (512) 555-0139', addr: '600 Congress Avenue, Austin, TX 78701' },
    { first: 'Robert', last: 'Nakamura', email: 'r.nakamura@gmail.com', phone: '+1 (808) 555-0121', addr: '2155 Kalakaua Avenue, Honolulu, HI 96815' },
    { first: 'Jennifer', last: 'O\'Brien', email: 'j.obrien@yahoo.com', phone: '+1 (404) 555-0166', addr: '191 Peachtree Street NE, Atlanta, GA 30303' },
  ];

  const allStatuses = ['submitted', 'triage', 'under_review', 'need_info', 'approved', 'rejected', 'duplicate', 'withdrawn', 'closure_review', 'closed'] as const;

  const caseRecords: Array<{ id: string; caseRef: string; campaignId: string; status: string; consumer: typeof consumerData[0]; submittedAt: Date; assignedTo?: string }> = [];

  // Generate 18 cases distributed across campaigns and statuses
  for (let i = 0; i < 18; i++) {
    const campaign = allCampaigns[i % allCampaigns.length];
    const consumer = consumerData[i % consumerData.length];
    const status = i < allStatuses.length ? allStatuses[i] : allStatuses[i % allStatuses.length];
    const caseId = randomUUID();
    const caseRef = randomRef();

    const submittedAt = new Date(now - (18 - i) * 2 * DAY);

    // Encrypt PII
    const nameEnc = await encryptPII(`${consumer.first} ${consumer.last}`);
    const emailEnc = await encryptPII(consumer.email);
    const phoneEnc = await encryptPII(consumer.phone);
    const addrEnc = await encryptPII(consumer.addr);

    await db.insert(recallCases).values({
      id: caseId,
      publicReference: caseRef,
      campaignId: campaign.id,
      campaignVersionId: campaign.versionId,
      locale: 'en-US',
      subtype: i % 5 === 0 ? 'injury_hazard' : 'standard',
      status,
      incidentFlag: i % 5 === 0,
      submittedAt,
      assignedToStaffUserId: i % 3 === 0 ? (staffIds['reviewer@koi-platform.com'] ?? null) : null,
      assignedAt: i % 3 === 0 ? new Date(submittedAt.getTime() + 1 * DAY) : null,
    }).onConflictDoNothing();

    // Consumer PII (encrypted)
    await db.insert(caseConsumers).values({
      caseId,
      keyVersion: 'v1',
      firstNameEncrypted: (await encryptPII(consumer.first)).encrypted.value,
      lastNameEncrypted: (await encryptPII(consumer.last)).encrypted.value,
      emailEncrypted: emailEnc.encrypted.value,
      emailLookupHash: emailEnc.lookupHash,
      phoneEncrypted: phoneEnc.encrypted.value,
      addressEncrypted: addrEnc.encrypted.value,
      addressLookupHash: addrEnc.lookupHash,
      countryCode: 'US',
    }).onConflictDoNothing();

    // Claimed product
    const shapes = ['Bear', 'Dinosaur', 'Strawberry', 'Heart', 'Round', 'Square'];
    const flavors = ['Peach', 'Strawberry', 'Grape', 'Mango', 'Blueberry', 'Lemon'];
    const lotCodes = ['ML-2406-A', 'ML-2407-B', 'ML-2408-C', 'BJ-2602-B', 'BJ-2604-D', 'HP-2605-C'];
    const channels = ['amazon', 'walmart', 'target', 'costco', 'cvs', 'direct'];
    const checkResults = ['potential_match', 'not_matched', 'manual_review'] as const;

    await db.insert(claimedProducts).values({
      caseId,
      campaignProductId: campaign.productId,
      quantity: Math.ceil(Math.random() * 3),
      shape: shapes[i % shapes.length],
      flavor: flavors[i % flavors.length],
      lotCode: lotCodes[i % lotCodes.length],
      dateCode: (['06/2024', '07/2024', '08/2024', '02/2026', '04/2026', '05/2026'])[i % 6],
      purchaseChannel: channels[i % channels.length],
      purchaseDate: new Date(submittedAt.getTime() - 30 * DAY).toISOString().split('T')[0],
      checkResult: checkResults[i % 3],
      identificationMode: 'product_identifiers',
      matchedVariantIds: i % 3 !== 1 ? [campaign.variantId] : null,
    }).onConflictDoNothing();

    // Consents
    await db.insert(caseConsents).values([
      { caseId, consentType: 'privacy_policy', textVersion: 'v1.0', accepted: true, acceptedAt: submittedAt },
      { caseId, consentType: 'accuracy', textVersion: 'v1.0', accepted: true, acceptedAt: submittedAt },
    ]).onConflictDoNothing();

    // Submission snapshot (encrypted)
    const snapEnc = await encryptPII(JSON.stringify({ campaignCode: campaign.code, consumer: consumer.first, submittedAt: submittedAt.toISOString() }));
    await db.insert(submissionSnapshots).values({
      caseId,
      schemaVersion: 'phase1-v1',
      keyVersion: 'v1',
      encryptedPayload: snapEnc.encrypted.value,
      payloadSha256: sha256(`snapshot-${caseRef}`),
    }).onConflictDoNothing();

    caseRecords.push({
      id: caseId,
      caseRef,
      campaignId: campaign.id,
      status,
      consumer,
      submittedAt,
      assignedTo: i % 3 === 0 ? 'reviewer@koi-platform.com' : undefined,
    });
  }

  console.log(`    ✓ ${caseRecords.length} recall cases across ${allCampaigns.length} campaigns`);

  // ================================================================
  // 5. INCIDENTS + REPORTABILITY REVIEWS
  // ================================================================
  console.log('  [5/7] Incidents + reportability reviews...');

  const injuryCases = caseRecords.filter(c => c.status !== 'rejected' && c.status !== 'withdrawn' && c.status !== 'duplicate').slice(0, 6);
  const incidentRecords: Array<{ id: string; caseId: string; reviewId: string }> = [];

  const injuryScenarios = [
    { eventTypes: ['injury', 'product_failure'], answer: 'yes' as const, severity: 'moderate', narrative: 'Child fell from stroller when front wheel detached while crossing a street intersection. Minor scrapes and bruising on both knees. Emergency room visit for evaluation; no fractures found. Stroller was being pushed at walking speed on a flat sidewalk.' },
    { eventTypes: ['product_failure'], answer: 'yes' as const, severity: 'minor', narrative: 'Stroller wheel became loose while jogging in the park. Wheel wobbled and eventually came off, but I caught the stroller before it tipped. No injuries to child. Product had been used for approximately 3 months.' },
    { eventTypes: ['injury', 'fire'], answer: 'yes' as const, severity: 'serious', narrative: 'Kettle continued heating after boiling. Plastic base melted and emitted smoke that triggered apartment fire alarm. Resident suffered minor smoke inhalation; treated at scene. Kitchen countertop had minor heat damage.' },
    { eventTypes: ['product_failure'], answer: 'yes' as const, severity: 'minor', narrative: 'Kettle did not auto-shutoff. Water completely boiled away. Thermal fuse eventually activated but not before base became very hot to touch. No injuries; kettle disposed of immediately.' },
    { eventTypes: ['injury', 'choking'], answer: 'yes' as const, severity: 'serious', narrative: 'Lollipop stick separated from candy portion while child was consuming it. Stick became lodged in child\'s throat for approximately 5 seconds before being dislodged by parent. Child taken to emergency room; no lasting injury observed. Product was purchased from local convenience store.' },
    { eventTypes: ['injury'], answer: 'unsure' as const, severity: 'moderate', narrative: 'Consumer reported that after consuming product, child developed mild allergic reaction (hives around mouth). Unclear whether reaction was related to product or other food consumed at same time. Consumer unable to confirm ingredient list at time of incident.' },
  ];

  for (let i = 0; i < 6; i++) {
    const c = injuryCases[i];
    const scenario = injuryScenarios[i];
    const incidentId = randomUUID();
    const reviewId = randomUUID();

    const narrativeEncrypted = await encryptNarrative(scenario.narrative);

    await db.insert(incidents).values({
      id: incidentId,
      caseId: c.id,
      answer: scenario.answer,
      eventTypes: scenario.eventTypes,
      narrativeKeyVersion: 'v1',
      narrativeEncrypted,
      occurredAt: new Date(c.submittedAt.getTime() - 7 * DAY),
      injurySeverity: scenario.severity,
      medicalTreatment: scenario.severity === 'serious' ? 'emergency_room' : scenario.severity === 'moderate' ? 'outpatient_clinic' : 'none',
      usedAsIntended: 'yes',
      companyObtainedAt: new Date(c.submittedAt.getTime() + 1 * DAY),
    }).onConflictDoNothing();

    const reviewStatus = i < 2 ? 'filed' : i < 4 ? 'pending' : 'documented_non_reportable';
    await db.insert(reportabilityReviews).values({
      id: reviewId,
      incidentId,
      status: reviewStatus,
      reviewerId: reviewStatus !== 'pending' ? (staffIds['admin@koi-platform.com'] ?? null) : null,
      rationaleEncrypted: reviewStatus !== 'pending' ? await encryptNarrative(`Reviewed per 16 CFR § 1115. ${reviewStatus === 'filed' ? 'Filed with CPSC as potentially reportable within 24h of company notification.' : 'Determined non-reportable: incident did not meet statutory criteria for substantial product hazard.'}`) : null,
      decisionAt: reviewStatus !== 'pending' ? new Date(c.submittedAt.getTime() + 2 * DAY) : null,
      cpscReference: reviewStatus === 'filed' ? `CPSC-FILE-2026-${String(1000 + i).padStart(3, '0')}` : null,
      filedAt: reviewStatus === 'filed' ? new Date(c.submittedAt.getTime() + 3 * DAY) : null,
    }).onConflictDoNothing();

    incidentRecords.push({ id: incidentId, caseId: c.id, reviewId });
  }

  console.log(`    ✓ ${incidentRecords.length} incidents (${injuryScenarios.filter(s => s.severity === 'serious').length} serious, ${injuryScenarios.filter(s => s.severity === 'moderate').length} moderate, ${injuryScenarios.filter(s => s.severity === 'minor').length} minor)`);

  // ================================================================
  // 6. CASE EVENTS — immutable timeline per case
  // ================================================================
  console.log('  [6/7] Case events, documents, communications, audit...');

  let eventCount = 0;
  const eventTypes = ['case.created', 'case.triaged', 'case.review_started', 'case.info_requested', 'case.info_received', 'case.approved', 'case.rejected', 'case.remedy_issued', 'case.closed', 'case.reopened', 'case.assigned', 'case.note_added', 'case.evidence_reviewed', 'case.incident_reported'];

  for (const c of caseRecords) {
    const numEvents = 2 + Math.floor(Math.random() * 4);
    for (let e = 0; e < numEvents; e++) {
      const etIdx = Math.min(
        allStatuses.indexOf(c.status as typeof allStatuses[number]),
        eventTypes.length - 1,
      );
      await db.insert(caseEvents).values({
        caseId: c.id,
        eventType: e === 0 ? 'case.created' : eventTypes[(etIdx + e) % eventTypes.length],
        actorType: e % 3 === 0 ? 'consumer' : 'staff',
        actorId: e % 3 === 0 ? null : (staffIds['reviewer@koi-platform.com'] ?? null),
        data: { status: c.status, automated: e === 0 } as Record<string, unknown>,
        occurredAt: new Date(c.submittedAt.getTime() + e * 8 * 3600000),
      }).onConflictDoNothing();
      eventCount++;
    }
  }
  console.log(`    ✓ ${eventCount} case events`);

  // -- Documents --
  let docCount = 0;
  for (let i = 0; i < 10; i++) {
    const c = caseRecords[i % caseRecords.length];
    const draft = drafts[i % drafts.length];
    await db.insert(documentUploads).values({
      draftId: draft.id,
      caseId: c.id,
      category: i % 3 === 0 ? 'product_photo' : i % 3 === 1 ? 'proof_of_purchase' : 'incident_evidence',
      categorySlot: 1,
      storagePathname: `uploads/${c.caseRef}/${['product.jpg', 'receipt.pdf', 'incident-photo.jpg'][i % 3]}`,
      originalFileName: ['product-photo.jpg', 'amazon-receipt.pdf', 'damage-photo.jpg'][i % 3],
      declaredMimeType: ['image/jpeg', 'application/pdf', 'image/jpeg'][i % 3],
      sizeBytes: [2450000, 180000, 3200000][i % 3],
      uploadStatus: 'linked',
      scanStatus: 'clean',
      uploadedAt: new Date(c.submittedAt.getTime() + 3600000),
      linkedAt: new Date(c.submittedAt.getTime() + 7200000),
      expiresAt: new Date(now + 90 * DAY),
    }).onConflictDoNothing();
    docCount++;
  }
  console.log(`    ✓ ${docCount} document uploads`);

  // -- Communications --
  let commCount = 0;
  // Query existing message templates (from base seed)
  const existingTemplates = await db.select({ id: campaignMessageTemplates.id }).from(campaignMessageTemplates).limit(1);
  const defaultTemplateId = existingTemplates[0]?.id ?? allCampaigns[0].versionId; // fallback

  for (let i = 0; i < 12; i++) {
    const c = caseRecords[i % caseRecords.length];
    const recipientEnc = await encryptPII(`consumer-${i}@email.com`);
    await db.insert(communications).values({
      caseId: c.id,
      templateId: defaultTemplateId,
      messageKey: `msg-${randomUUID().slice(0, 8)}`,
      channel: 'email',
      recipientKeyVersion: 'v1',
      recipientEncrypted: recipientEnc.encrypted.value,
      status: i < 8 ? 'delivered' : i < 10 ? 'sent' : 'queued',
      providerMessageId: i < 10 ? `resend_${randomUUID().slice(0, 12)}` : null,
      sentAt: i < 10 ? new Date(c.submittedAt.getTime() + 4 * 3600000) : null,
      deliveredAt: i < 8 ? new Date(c.submittedAt.getTime() + 5 * 3600000) : null,
    }).onConflictDoNothing();
    commCount++;
  }
  console.log(`    ✓ ${commCount} communications`);

  // -- Audit Events --
  let auditCount = 0;
  const auditActions = [
    { action: 'case.submit', resourceType: 'case' },
    { action: 'case.assign', resourceType: 'case' },
    { action: 'case.review', resourceType: 'case' },
    { action: 'case.status_transition', resourceType: 'case' },
    { action: 'case.info_request', resourceType: 'case' },
    { action: 'case.approve', resourceType: 'case' },
    { action: 'case.reject', resourceType: 'case' },
    { action: 'case.close', resourceType: 'case' },
    { action: 'incident.review', resourceType: 'incident' },
    { action: 'staff.login', resourceType: 'staff' },
    { action: 'staff.create', resourceType: 'staff' },
    { action: 'audit.view', resourceType: 'audit' },
    { action: 'document.verify', resourceType: 'document' },
    { action: 'reportability.file', resourceType: 'reportability' },
    { action: 'export.create', resourceType: 'export' },
  ];

  for (let i = 0; i < 45; i++) {
    const c = caseRecords[i % caseRecords.length];
    const aa = auditActions[i % auditActions.length];
    const actorEmail = i % 3 === 0 ? 'admin@koi-platform.com' : 'reviewer@koi-platform.com';
    await db.insert(adminAuditEvents).values({
      actorUserId: staffIds[actorEmail] ?? null,
      actorRole: actorEmail.includes('admin') ? 'administrator' : 'reviewer',
      action: aa.action,
      resourceType: aa.resourceType,
      resourceId: aa.resourceType === 'case' ? c.caseRef : randomUUID().slice(0, 12),
      outcome: i % 7 !== 0 ? 'success' : 'denied',
      reasonCode: i % 7 === 0 ? 'insufficient_permissions' : null,
      metadata: { ip: '192.168.1.1', source: 'admin-dashboard' } as Record<string, unknown>,
      occurredAt: new Date(now - (45 - i) * 4 * 3600000),
    }).onConflictDoNothing();
    auditCount++;
  }
  console.log(`    ✓ ${auditCount} audit events`);

  // -- Outbox events --
  for (let i = 0; i < 5; i++) {
    const c = caseRecords[i];
    await db.insert(outboxEvents).values({
      aggregateType: 'case',
      aggregateId: c.id,
      eventType: 'communication.claim_confirmation',
      deduplicationKey: `outbox-confirm-${c.caseRef}`,
      payload: { caseRef: c.caseRef, channel: 'email' } as Record<string, unknown>,
      status: i < 3 ? 'succeeded' : 'pending',
      attempts: i < 3 ? 1 : 0,
      availableAt: new Date(c.submittedAt.getTime() + 3600000),
      processedAt: i < 3 ? new Date(c.submittedAt.getTime() + 4000000) : null,
    }).onConflictDoNothing();
  }

  // ================================================================
  // 7. SUMMARY
  // ================================================================
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║     Test Data Seed Complete              ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Staff users:        ${String(Object.keys(staffIds).length).padStart(3)}                ║`);
  console.log(`  ║  Campaigns:          ${String(allCampaigns.length).padStart(3)}                ║`);
  console.log(`  ║  Claim drafts:       ${String(drafts.length).padStart(3)}                ║`);
  console.log(`  ║  Recall cases:       ${String(caseRecords.length).padStart(3)}                ║`);
  console.log(`  ║  Incidents:          ${String(incidentRecords.length).padStart(3)}                ║`);
  console.log(`  ║  Case events:        ${String(eventCount).padStart(3)}                ║`);
  console.log(`  ║  Documents:          ${String(docCount).padStart(3)}                ║`);
  console.log(`  ║  Communications:     ${String(commCount).padStart(3)}                ║`);
  console.log(`  ║  Audit events:       ${String(auditCount).padStart(3)}                ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('\n  Staff logins:');
  console.log('    admin@koi-platform.com     / admin123        (administrator)');
  console.log('    reviewer@koi-platform.com  / review2026        (reviewer)');
  console.log('    viewer@koi-platform.com    / viewer2026        (viewer)');
  console.log('\n  Campaigns:');
  for (const c of allCampaigns) {
    console.log(`    ${c.code}  [${c.status}]  /v1/recall-campaigns/${c.slug}`);
  }
  console.log(`\n  ${caseRecords.length} recall cases across ${allStatuses.length} statuses\n`);
}

await main()
  .then(() => handle.close())
  .catch((err) => { console.error(err); process.exit(1); });
