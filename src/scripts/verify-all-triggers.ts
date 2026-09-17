import 'dotenv/config';

import { and, desc, eq } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { templateVersions } from '../db/schema/index.js';
import { loadConfig } from '../config/env.js';
import { createEmailAdapter } from '../composition.js';
import { EmailRenderer } from '../platform/email/renderer.js';

/**
 * Connectivity check for every trigger-point template: confirms a
 * template_versions row exists for each key and that all three bodies render
 * cleanly with representative sample variables (the renderer is fail-closed, so
 * any leftover placeholder throws).
 *
 * Set `TEST_EMAIL_TO` to additionally push each rendered template through the
 * real email adapter — the same port the outbox worker drains — which proves the
 * provider accepts what these templates produce. Without it the script stays
 * read-only and is safe to run against production data.
 */
const SAMPLE_VARIABLES: Record<string, Record<string, string>> = {
  claim_confirmation: { caseReference: 'TEST-123', submittedAt: new Date().toISOString() },
  need_info: {
    caseReference: 'TEST-123',
    requestedInformation: 'A photo of the product label showing the lot number',
    actionUrl: 'https://example.example/dashboard/claims/TEST-123',
  },
  refund_approved: { caseReference: 'TEST-123', refundAmount: '19.99', refundCurrency: 'USD' },
  replacement_approved: { caseReference: 'TEST-123', replacementItem: 'Replacement Product' },
  claim_rejected: {
    caseReference: 'TEST-123',
    reason: 'The product was outside the recalled lot range.',
  },
  refund_completed: {
    caseReference: 'TEST-123',
    refundAmount: '19.99',
    refundCurrency: 'USD',
    referenceLine: 'Reference: BANK-REF-001',
  },
  shipment_shipped: { caseReference: 'TEST-123', trackingNumber: 'TRK-000-001' },
  case_completed: { caseReference: 'TEST-123', completedResolutionLabel: 'Refund' },
  case_closed: {
    caseReference: 'TEST-123',
    closureReason: 'The case was withdrawn at the consumer request.',
  },
};

async function verify() {
  const config = loadConfig();
  const { db } = createDatabase(config.DATABASE_URL!);
  const recipient = process.env.TEST_EMAIL_TO?.trim();
  const email = recipient ? createEmailAdapter(config) : null;

  console.log('--- Start: all trigger-point connectivity check ---');
  if (recipient) {
    console.log(`send mode: ON -> ${recipient} via ${email!.constructor.name}`);
  } else {
    console.log('send mode: OFF (set TEST_EMAIL_TO to also send each template)');
  }
  console.log('');

  let missing = 0;
  let broken = 0;
  let sendFailed = 0;
  let sent = 0;

  for (const [key, variables] of Object.entries(SAMPLE_VARIABLES)) {
    const [row] = await db
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.templateKey, key), eq(templateVersions.locale, 'en-US')))
      .orderBy(desc(templateVersions.version))
      .limit(1);
    if (!row) {
      console.log(`[MISSING] ${key}`);
      missing += 1;
      continue;
    }

    let subject: string;
    let html: string;
    let text: string;
    try {
      subject = EmailRenderer.render(row.subject, variables);
      html = EmailRenderer.render(row.htmlBody, variables);
      // The text part is what plain-text clients and spam filters read. It went
      // unchecked before, so a placeholder left here would only surface at send
      // time — on a real consumer's notice.
      text = EmailRenderer.render(row.textBody, variables);
    } catch (err) {
      console.log(`[BROKEN]  ${key} v${row.version} render failed: ${String(err)}`);
      broken += 1;
      continue;
    }

    if (!email || !recipient) {
      console.log(`[OK]      ${key} v${row.version} rendered — "${subject}"`);
      continue;
    }

    try {
      const result = await email.send({ messageKey: key, to: recipient, subject, html, text });
      sent += 1;
      console.log(`[SENT]    ${key} v${row.version} -> ${result.providerMessageId}`);
    } catch (err) {
      sendFailed += 1;
      console.log(`[FAILED]  ${key} v${row.version} send failed: ${String(err)}`);
    }
  }

  const total = Object.keys(SAMPLE_VARIABLES).length;
  console.log('');
  console.log(
    `--- End: ${total - missing - broken} rendered, ${missing} missing, ${broken} broken` +
      (email ? `, ${sent} sent, ${sendFailed} send failures` : '') +
      ' ---',
  );
  if (missing > 0 || broken > 0 || sendFailed > 0) process.exitCode = 1;
}

verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
