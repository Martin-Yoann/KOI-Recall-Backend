import { and, eq, sql } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { campaignMessageTemplates, communications, templateVersions } from '../db/schema/index.js';
import { loadConfig } from '../config/env.js';

/**
 * One-time backfill: mirrors each campaign message template into
 * template_versions using its semantic identity (templateType as templateKey,
 * the template's own locale and version), then pins existing communications
 * to the mirrored version so the outbox worker can drain legacy rows.
 * Re-running is safe — conflicts on (templateKey, locale, version) reuse the
 * existing mirrored row.
 */
async function migrateTemplates() {
  console.log('Starting template migration...');
  const config = loadConfig();
  const { db } = createDatabase(config.DATABASE_URL!);

  const templates = await db.select().from(campaignMessageTemplates);

  for (const t of templates) {
    const [mirrored] = await db
      .insert(templateVersions)
      .values({
        templateKey: t.templateType,
        locale: t.locale,
        version: t.version,
        subject: t.subject,
        htmlBody: t.htmlBody,
        textBody: t.textBody,
      })
      .onConflictDoUpdate({
        target: [templateVersions.templateKey, templateVersions.locale, templateVersions.version],
        set: {
          subject: sql`excluded.subject`,
          htmlBody: sql`excluded.html_body`,
          textBody: sql`excluded.text_body`,
        },
      })
      .returning({ id: templateVersions.id });

    if (!mirrored) continue;

    await db
      .update(communications)
      .set({ templateVersionId: mirrored.id })
      .where(and(eq(communications.templateId, t.id), sql`template_version_id is null`));

    console.log(
      `Migrated template ${t.id} (${t.templateType}, ${t.locale}, v${t.version}) to version ID ${mirrored.id}`,
    );
  }

  console.log('Migration complete.');
}

migrateTemplates().catch(console.error);
