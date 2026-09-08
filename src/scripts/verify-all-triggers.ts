import { createDatabase } from '../db/client.js';
import { EmailRenderer } from '../platform/email/renderer.js';
import { loadConfig } from '../config/env.js';
import { templateVersions } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

async function verify() {
  console.log('--- Start: all trigger-point connectivity check ---');
  const config = loadConfig();
  const { db } = createDatabase(config.DATABASE_URL!);

  const scenarios = [
    'claim_confirmation',
    'need_info',
    'refund_approved',
    'replacement_approved',
    'claim_rejected',
    'refund_completed',
    'shipment_shipped',
    'case_closed',
  ];

  for (const key of scenarios) {
    const template = await db
      .select()
      .from(templateVersions)
      .where(eq(templateVersions.templateKey, key))
      .limit(1);
    if (template.length > 0) {
      const row = template[0]!;
      console.log(`[OK] template [${key}] is ready`);
      try {
        const rendered = EmailRenderer.render(row.subject, { caseReference: 'TEST-123' });
        console.log(`     render test (Subject): ${rendered}`);
      } catch (err) {
        console.log(`     render test failed: ${String(err)}`);
      }
    } else {
      console.log(`[MISSING] template [${key}] is not found`);
    }
  }
  console.log('--- End of test ---');
}
verify().catch(console.error);
