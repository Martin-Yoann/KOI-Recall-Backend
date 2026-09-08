import { eq } from 'drizzle-orm';
import { caseConsumers } from '../../db/schema/index.js';
import type { DatabaseExecutor } from '../../db/client.js';
import type { NotificationService } from './service.js';
import { getLatestTemplateVersionId } from './template-loader.js';

/**
 * Service to orchestrate email triggering:
 * 1. Resolves the latest template version ID.
 * 2. Fetches encrypted recipient data.
 * 3. Enqueues the notification into the outbox.
 */
export class EmailTriggerService {
  constructor(private readonly notifications: NotificationService) {}

  async trigger(
    tx: DatabaseExecutor,
    params: {
      caseId: string;
      templateKey: string;
      locale: string;
      variables: Record<string, any>;
      deduplicationKey: string;
    }
  ) {
    // 1. 获取收件人加密信息
    const [consumer] = await tx
      .select({
        keyVersion: caseConsumers.keyVersion,
        emailEncrypted: caseConsumers.emailEncrypted,
      })
      .from(caseConsumers)
      .where(eq(caseConsumers.caseId, params.caseId))
      .limit(1);

    if (!consumer) throw new Error(`[EmailTrigger] Case consumer not found for ${params.caseId}`);

    // 2. 获取最新版本模板 ID
    const templateVersionId = await getLatestTemplateVersionId(tx, params.templateKey, params.locale);

    // 3. 入队通知
    await this.notifications.queueNotification(tx, {
      caseId: params.caseId,
      templateVersionId,
      recipientKeyVersion: consumer.keyVersion,
      recipientEncrypted: consumer.emailEncrypted,
      deduplicationKey: params.deduplicationKey,
      variables: params.variables,
    });
  }
}
