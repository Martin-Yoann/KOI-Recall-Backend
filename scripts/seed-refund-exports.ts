import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { createDatabase } from '../src/db/client.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import {
  caseConsumers,
  caseResolutions,
  campaignVersions,
  recallCampaigns,
  recallCases,
  staffUsers,
} from '../src/db/schema/index.js';

/**
 * Seeds a handful of recall cases whose resolution is an externally-completed
 * REFUND — exactly what the refund export (/admin/refund-exports) reads — so
 * the Exports page produces a real CSV instead of headers-only.
 *
 * Idempotent-ish: every case uses a fresh KOI-XXXX-XXXXXXXX reference and the
 * inserts are `onConflictDoNothing`, so re-running adds new rows rather than
 * clobbering existing data.
 */

const databaseUrl = process.env.DATABASE_URL;
const encKey = process.env.FIELD_ENCRYPTION_KEY;
const pepper = process.env.HASH_PEPPER;
if (!databaseUrl) throw new Error('DATABASE_URL required');
if (!encKey || !pepper) throw new Error('FIELD_ENCRYPTION_KEY and HASH_PEPPER required');

const handle = createDatabase(databaseUrl);
const db = handle.db;
const crypto = new NodeSensitiveDataCrypto(encKey, pepper);

const DAY = 86_400_000;

function randomRef(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = 'KOI-';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  out += '-';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const SALES = [
  { name: 'Alice Newton', email: 'alice.newton@example.com', phone: '14155558101', amount: 749, currency: 'USD', external: 'REF-2026-9001' },
  { name: 'Marcus Ford', email: 'marcus.ford@example.com', phone: '14155558102', amount: 1250, currency: 'USD', external: 'REF-2026-9002' },
  { name: 'Sofia Gomez', email: 'sofia.gomez@example.com', phone: '14155558103', amount: 599, currency: 'USD', external: 'REF-2026-9003' },
  { name: 'Darsh Patel', email: 'darsh.patel@example.com', phone: '14155558104', amount: 899, currency: 'USD', external: 'REF-2026-9004' },
  { name: 'Lena Voss', email: 'lena.voss@example.com', phone: '14155558105', amount: 1149, currency: 'USD', external: 'REF-2026-9005' },
];

async function main() {
  // Find an existing campaign (prefer the music demo) and one of its versions.
  const [campaign] = await db
    .select({ id: recallCampaigns.id })
    .from(recallCampaigns)
    .where(eq(recallCampaigns.slug, 'music-lollipop-demo-2026'))
    .limit(1);
  if (!campaign?.id) throw new Error('Seed campaign not found — run scripts/seed-test-data.ts first.');

  const [version] = await db
    .select({ id: campaignVersions.id })
    .from(campaignVersions)
    .where(eq(campaignVersions.campaignId, campaign.id))
    .limit(1);
  if (!version?.id) throw new Error('No campaign version found for the seed campaign.');

  const [approver] = await db
    .select({ id: staffUsers.id })
    .from(staffUsers)
    .where(eq(staffUsers.email, 'admin@koi-platform.com'))
    .limit(1);

  const now = new Date();
  const created: string[] = [];

  for (let i = 0; i < SALES.length; i++) {
    const sale = SALES[i]!;
    const caseId = randomUUID();
    const caseRef = randomRef();
    const submittedAt = new Date(now.getTime() - (SALES.length - i) * DAY);
    const keyVersion = 'v1';

    await db.insert(recallCases).values({
      id: caseId,
      publicReference: caseRef,
      campaignId: campaign.id,
      campaignVersionId: version.id,
      locale: 'en-US',
      subtype: 'standard',
      status: 'closed',
      incidentFlag: false,
      submittedAt,
    }).onConflictDoNothing();

    const emailEnc = await crypto.encrypt(sale.email);
    const phoneEnc = sale.phone ? await crypto.encrypt(sale.phone) : null;
    const addrEnc = await crypto.encrypt('123 Test Street, Test City, CA, 94105, US');
    await db.insert(caseConsumers).values({
      caseId,
      keyVersion,
      firstNameEncrypted: (await crypto.encrypt(sale.name.split(' ')[0]!)).value,
      lastNameEncrypted: (await crypto.encrypt(sale.name.split(' ').slice(1).join(' ') || sale.name)).value,
      emailEncrypted: emailEnc.value,
      emailLookupHash: await crypto.lookupHash(sale.email.toLowerCase().trim()),
      phoneEncrypted: phoneEnc?.value ?? null,
      addressEncrypted: addrEnc.value,
      addressLookupHash: await crypto.lookupHash('123 Test Street, Test City, CA, 94105, US'.toLowerCase().trim()),
      countryCode: 'US',
    }).onConflictDoNothing();

    const approvedNote = await crypto.encrypt('Approved refund for reconciliation test data.');
    const completionNote = await crypto.encrypt('Refund processed in the finance system (test data).');
    await db.insert(caseResolutions).values({
      caseId,
      requestedType: 'refund',
      approvedType: 'refund',
      status: 'externally_completed',
      refundAmountMinor: sale.amount,
      currency: sale.currency,
      approvedByStaffUserId: approver?.id ?? null,
      approvedAt: new Date(submittedAt.getTime() + DAY),
      approvalNoteEncrypted: approvedNote.value,
      approvalNoteKeyVersion: keyVersion,
      externalReference: sale.external,
      completionNoteEncrypted: completionNote.value,
      completionNoteKeyVersion: keyVersion,
      completedByStaffUserId: approver?.id ?? null,
      completedAt: new Date(submittedAt.getTime() + 2 * DAY),
      version: 1,
    }).onConflictDoNothing();

    created.push(`${caseRef} → ${sale.amount} ${sale.currency}`);
  }

  console.log(`Seeded ${created.length} refund-exportable cases:`);
  for (const line of created) console.log('  •', line);
  await handle.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED', err instanceof Error ? err.message : err);
  process.exit(1);
});
