import 'dotenv/config';

import { createEmailAdapter } from '../composition.js';
import { loadConfig } from '../config/env.js';

/**
 * Sends one real email through the configured Resend adapter — the same port
 * the outbox worker drains — so an invalid key, an unverified sender, or a
 * missing env var fails here instead of silently in a case workflow.
 *
 * Resend's shared `onboarding@resend.dev` sender only delivers to the address
 * that owns the Resend account; a verified domain is required to reach anyone
 * else.
 *
 * Usage: pnpm email:test <recipient>   (or set TEST_EMAIL_TO)
 */
async function sendTestEmail(recipient: string): Promise<void> {
  const config = loadConfig();
  const email = createEmailAdapter(config);

  console.log(`Sending via ${email.constructor.name} as ${config.RESEND_FROM_EMAIL}...`);
  const result = await email.send({
    messageKey: 'smoke_test',
    to: recipient,
    subject: 'KOI Recall — Resend smoke test',
    html: '<p>Congrats on sending your <strong>first email</strong>!</p>',
    text: 'Congrats on sending your first email!',
  });
  console.log(`Accepted by Resend, message id: ${result.providerMessageId}`);
}

const recipient = process.argv[2] ?? process.env.TEST_EMAIL_TO;

// No hardcoded fallback: a smoke test should never quietly mail a personal
// inbox, and the address belongs in configuration rather than in source.
if (!recipient) {
  console.error(
    'No recipient given. Pass one, or set TEST_EMAIL_TO in .env:\n' +
      '  pnpm email:test you@yourdomain.com',
  );
  process.exit(1);
}

try {
  await sendTestEmail(recipient);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
