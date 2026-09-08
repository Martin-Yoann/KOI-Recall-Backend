import { and, desc, eq } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { templateVersions } from '../db/schema/index.js';
import { loadConfig } from '../config/env.js';
import { EmailRenderer } from '../platform/email/renderer.js';

/**
 * Connectivity check for every trigger-point template: confirms a
 * template_versions row exists for each key and that it renders cleanly with
 * representative sample variables (fail-closed would throw on any leftover
 * placeholder).
 */
const SAMPLE_VARIABLES: Record<string, Record<string, string>> = {
  claim_confirmation: { caseReference: 'TEST-123', submittedAt: new Date().toISOString() },
  need_info: { caseReference: 'TEST-123', actionUrl: 'https://example.example/need-info' },
  refund_approved: { caseReference: 'TEST-123', refundAmount: '19.99', refundCurrency: 'USD' },
  replacement_approved: { caseReference: 'TEST-123', replacementItem: 'Replacement Product' },
  claim_rejected: { caseReference: 'TEST-123', reason: 'Sample rejection reason' },
  refund_completed: { caseReference: 'TEST-123', bankReference: 'BANK-REF-001' },
  shipment_shipped: { caseReference: 'TEST-123', trackingNumber: 'TRK-000-001' },
  case_closed: { caseReference: 'TEST-123', closureReason: 'Case resolved' },
};

async function verify() {
  console.log('--- Start: all trigger-point connectivity check ---');
  const config = loadConfig();
  const { db } = createDatabase(config.DATABASE_URL!);

  let missing = 0;
  let broken = 0;

  for (const [key, variables] of Object.entries(SAMPLE_VARIABLES)) {
    const [row] = await db
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.templateKey, key), eq(templateVersions.locale, 'en-US')))
      .orderBy(desc(templateVersions.version))
      .limit(1);
    if (!row) {
      console.log(`[MISSING] template [${key}] is not found`);
      missing += 1;
      continue;
    }
    try {
      const subject = EmailRenderer.render(row.subject, variables);
      EmailRenderer.render(row.htmlBody, variables);
      console.log(`[OK] template [${key}] v${row.version} render test (Subject): ${subject}`);
    } catch (err) {
      console.log(`[BROKEN] template [${key}] render test failed: ${String(err)}`);
      broken += 1;
    }
  }
  console.log(
    `--- End of check: ${Object.keys(SAMPLE_VARIABLES).length - missing - broken} ok, ${missing} missing, ${broken} broken ---`,
  );
  if (missing > 0 || broken > 0) process.exitCode = 1;
}
verify().catch(console.error);
