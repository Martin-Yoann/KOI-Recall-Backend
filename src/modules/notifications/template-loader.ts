import { and, desc, eq } from 'drizzle-orm';
import { templateVersions } from '../../db/schema/index.js';
import type { DatabaseExecutor } from '../../db/client.js';

export async function getLatestTemplateVersionId(
  tx: DatabaseExecutor,
  templateKey: string,
  locale: string
): Promise<string> {
  const [row] = await tx
    .select({ id: templateVersions.id })
    .from(templateVersions)
    .where(and(eq(templateVersions.templateKey, templateKey), eq(templateVersions.locale, locale)))
    .orderBy(desc(templateVersions.version))
    .limit(1);
    
  if (!row) throw new Error(`[System Error] Template version missing: ${templateKey} (${locale})`);
  return row.id;
}
