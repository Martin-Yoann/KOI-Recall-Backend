import 'dotenv/config';
import { createDatabase } from '../db/client.js';
import { loadConfig } from '../config/env.js';
import { templateVersions } from '../db/schema/index.js';
import { spanishEmailTemplates } from '../modules/communications/spanish-templates.js';

// Add missing versions only. Never overwrite an operator-edited or approved template.
const config = loadConfig();
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to install templates.');
const handle = createDatabase(config.DATABASE_URL);
try {
  const rows = await handle.db
    .insert(templateVersions)
    .values(spanishEmailTemplates())
    .onConflictDoNothing()
    .returning({ id: templateVersions.id });
  console.log(`Added ${rows.length} Spanish transactional templates.`);
} finally {
  await handle.close();
}
