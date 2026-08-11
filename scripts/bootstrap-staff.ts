import 'dotenv/config';

import { createInterface } from 'node:readline';

import { createDatabase } from '../src/db/client.js';
import { loadConfig } from '../src/config/env.js';
import { DrizzleStaffService } from '../src/modules/staff/drizzle-staff-service.js';
import { promptSecret } from '../src/modules/staff/terminal-prompt.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';

/**
 * ADR-0004 B6: bootstraps the first `administrator` staff user. Run once per
 * fresh deployment before the B-end surface is usable:
 *
 *   pnpm staff:bootstrap
 *
 * Prompts interactively for email, display name, and password (password input
 * is read from stdin — for CI, pipe via stdin). Idempotent: exits 0 if the
 * email already exists (no duplicate created).
 *
 * Requires DATABASE_URL, FIELD_ENCRYPTION_KEY, and HASH_PEPPER in the
 * environment (the same secrets the running API uses).
 */

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const config = loadConfig();
  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to bootstrap a staff user.');
  }
  if (!config.FIELD_ENCRYPTION_KEY || !config.HASH_PEPPER) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY and HASH_PEPPER are required (the API must be able to hash email lookups).',
    );
  }

  const email = await prompt('Administrator email: ');
  if (!email.includes('@')) {
    throw new Error('That does not look like an email address.');
  }
  const displayName = await prompt('Display name: ');
  const password = await promptSecret('Password (min 12 chars): ');
  if (password.length < 12) {
    throw new Error('Password must be at least 12 characters.');
  }

  const handle = createDatabase(config.DATABASE_URL);
  const crypto = new NodeSensitiveDataCrypto(config.FIELD_ENCRYPTION_KEY, config.HASH_PEPPER);
  const staff = new DrizzleStaffService(handle.db, crypto);

  const existing = await staff.getStaffUserByEmail(email);
  if (existing) {
    process.stdout.write(`A staff user with email ${email} already exists — no action taken.\n`);
    await handle.close();
    return;
  }

  const created = await staff.createStaffUser({
    email,
    displayName: displayName || email.split('@')[0]!,
    role: 'administrator',
    password,
  });
  process.stdout.write(
    `Created administrator ${created.email} (id ${created.id}). You can now log in at /admin/sessions.\n`,
  );
  await handle.close();
}

main().catch((error) => {
  process.stderr.write(
    `bootstrap-staff failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
