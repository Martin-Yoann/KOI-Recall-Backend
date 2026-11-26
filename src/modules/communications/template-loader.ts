import { and, desc, eq, inArray, sql } from 'drizzle-orm';

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
  const [row] = await buildTemplateVersionQuery(tx, templateKey, locale);
  if (!row)
    throw new EmailTemplateMissingError(`No template version for ${templateKey} (${locale}).`);
  return row.id;
}

export function buildTemplateVersionQuery(
  tx: DatabaseExecutor,
  templateKey: string,
  locale: string,
) {
  return tx
    .select({ id: templateVersions.id })
    .from(templateVersions)
    .where(
      and(
        eq(templateVersions.templateKey, templateKey),
        inArray(templateVersions.locale, locale === 'es-US' ? ['es-US', 'en-US'] : [locale]),
      ),
    )
    .orderBy(
      sql`case when ${templateVersions.locale} = ${locale} then 0 else 1 end`,
      desc(templateVersions.version),
    )
    .limit(1);
}
