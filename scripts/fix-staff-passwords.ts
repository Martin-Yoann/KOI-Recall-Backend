// Fix staff passwords to use proper scrypt hashing
import 'dotenv/config';
import { createDatabase } from '../src/db/client.js';
import { staffUsers } from '../src/db/schema/staff.js';
import { hashPassword } from '../src/modules/staff/password.js';
import { eq } from 'drizzle-orm';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');

const handle = createDatabase(databaseUrl);
const { db } = handle;

async function fix() {
  // Delete existing staff first
  await db.delete(staffUsers);
  console.log('Cleared existing staff users');

  // Create with proper scrypt hashes (min 12 char passwords)
  const p1 = await hashPassword('admin123456!@');
  const p2 = await hashPassword('review2026!@#');
  const p3 = await hashPassword('viewer2026!@#');

  await db.insert(staffUsers).values([
    { email: 'admin@koi-platform.com', emailLookupHash: 'admin-hash-placeholder', displayName: 'Lin Wei (Admin)', role: 'administrator', status: 'active', passwordHash: p1, lastLoginAt: new Date() },
    { email: 'reviewer@koi-platform.com', emailLookupHash: 'reviewer-hash-placeholder', displayName: 'Chen Mei (Reviewer)', role: 'reviewer', status: 'active', passwordHash: p2, lastLoginAt: new Date() },
    { email: 'viewer@koi-platform.com', emailLookupHash: 'viewer-hash-placeholder', displayName: 'Wang Lei (Viewer)', role: 'viewer', status: 'active', passwordHash: p3, lastLoginAt: new Date() },
  ]);

  // Update lookup hashes properly
  const crypto = await import('../src/platform/crypto/node-sensitive-data-crypto.js');
  const encKey = process.env.FIELD_ENCRYPTION_KEY!;
  const pepper = process.env.HASH_PEPPER!;
  const c = new crypto.NodeSensitiveDataCrypto(encKey, pepper);

  for (const email of ['admin@koi-platform.com', 'reviewer@koi-platform.com', 'viewer@koi-platform.com']) {
    const hash = await c.lookupHash(email.toLowerCase().trim());
    await db.update(staffUsers).set({ emailLookupHash: hash }).where(eq(staffUsers.email, email));
  }

  console.log('Created 3 staff users with proper scrypt password hashes');
  console.log('  admin@koi-platform.com    / admin123456!@');
  console.log('  reviewer@koi-platform.com / review2026!@#');
  console.log('  viewer@koi-platform.com   / viewer2026!@#');
}

await fix().then(() => handle.close());
