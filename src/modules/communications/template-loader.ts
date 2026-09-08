import { and, desc, eq } from 'drizzle-orm';

import type { DatabaseExecutor } from '../../db/client.js';
import { templateVersions } from '../../db/schema/index.js';
import { EmailTemplateMissingError } from '../../shared/errors.js';

/**
 * Resolves the id of the newest template version for a template key + locale.
 * Shared by every trigger site so version selection stays in one place.
 */
export async function getLatestTemplateVersionId(
  tx: DatabaseExecutor,
  templateKey: string,
  locale: string,
): Promise<string> {
  const [row] = await tx
    .select({ id: templateVersions.id })
    .from(templateVersions)
    .where(and(eq(templateVersions.templateKey, templateKey), eq(templateVersions.locale, locale)))
    .orderBy(desc(templateVersions.version))
    .limit(1);

  if (!row)
    throw new EmailTemplateMissingError(`No template version for ${templateKey} (${locale}).`);
  return row.id;
}
