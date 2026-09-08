import { sql } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { templateVersions } from '../db/schema/index.js';
import { loadConfig } from '../config/env.js';

/**
 * Seeds the template version library with the known trigger-point templates.
 * Idempotent: re-running upserts each version row instead of wiping the
 * table, so existing rows (and communications pinned to them) survive.
 */
async function setupTemplates() {
  console.log('--- Start: initialize template version library ---');
  const config = loadConfig();
  const { db } = createDatabase(config.DATABASE_URL!);

  const templates = [
    {
      templateKey: 'claim_confirmation',
      locale: 'en-US',
      version: 1,
      subject: 'Your Claim {{caseReference}} Submission',
      htmlBody:
        '<h1>Submission Received</h1><p>Your claim {{caseReference}} has been submitted.</p>',
      textBody: 'Your claim {{caseReference}} has been submitted.',
    },
    {
      templateKey: 'need_info',
      locale: 'en-US',
      version: 1,
      subject: 'Need more info for {{caseReference}}',
      htmlBody: '<p>Please provide more info at {{actionUrl}}</p>',
      textBody: 'Please provide more info at {{actionUrl}}',
    },
    {
      templateKey: 'refund_approved',
      locale: 'en-US',
      version: 1,
      subject: 'Refund approved for {{caseReference}}',
      htmlBody: '<p>Refund of {{refundAmount}} {{refundCurrency}} approved.</p>',
      textBody: 'Refund of {{refundAmount}} {{refundCurrency}} approved.',
    },
    {
      templateKey: 'replacement_approved',
      locale: 'en-US',
      version: 1,
      subject: 'Replacement approved for {{caseReference}}',
      htmlBody: '<p>Replacement {{replacementItem}} approved.</p>',
      textBody: 'Replacement {{replacementItem}} approved.',
    },
    {
      templateKey: 'claim_rejected',
      locale: 'en-US',
      version: 1,
      subject: 'Claim {{caseReference}} update',
      htmlBody: '<p>Reason: {{reason}}</p>',
      textBody: 'Reason: {{reason}}',
    },
    {
      templateKey: 'refund_completed',
      locale: 'en-US',
      version: 1,
      subject: 'Refund completed for {{caseReference}}',
      htmlBody: '<p>Bank reference: {{bankReference}}</p>',
      textBody: 'Bank reference: {{bankReference}}',
    },
    {
      templateKey: 'shipment_shipped',
      locale: 'en-US',
      version: 1,
      subject: 'Shipment for {{caseReference}}',
      htmlBody: '<p>Tracking: {{trackingNumber}}</p>',
      textBody: 'Tracking: {{trackingNumber}}',
    },
    {
      templateKey: 'case_closed',
      locale: 'en-US',
      version: 1,
      subject: 'Case {{caseReference}} closed',
      htmlBody: '<p>Reason: {{closureReason}}</p>',
      textBody: 'Reason: {{closureReason}}',
    },
  ];

  console.log('Upserting templates...');
  await db
    .insert(templateVersions)
    .values(templates)
    .onConflictDoUpdate({
      target: [templateVersions.templateKey, templateVersions.locale, templateVersions.version],
      set: {
        subject: sql`excluded.subject`,
        htmlBody: sql`excluded.html_body`,
        textBody: sql`excluded.text_body`,
      },
    });
  console.log('--- Template library initialized ---');
}

setupTemplates().catch(console.error);
