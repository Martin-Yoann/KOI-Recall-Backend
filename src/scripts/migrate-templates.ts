import { eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { campaignMessageTemplates, communications, templateVersions } from '../db/schema/index.js';
import { loadConfig } from '../config/env.js';

async function migrateTemplates() {
  console.log('Starting template migration...');
  const config = loadConfig();
  const { db } = createDatabase(config.DATABASE_URL!);

  const templates = await db.select().from(campaignMessageTemplates);

  for (const t of templates) {
    const [inserted] = await db.insert(templateVersions).values({
      templateKey: t.id,
      locale: 'en-US',
      version: 1,
      subject: t.subject,
      htmlBody: t.htmlBody,
      textBody: t.textBody,
    }).returning({ id: templateVersions.id });

    if (!inserted) continue;

    await db.update(communications)
      .set({ templateVersionId: inserted.id })
      .where(eq(communications.templateId, t.id));

    console.log(`Migrated template ${t.id} to version ID ${inserted.id}`);
  }

  console.log('Migration complete.');
}

migrateTemplates().catch(console.error);
