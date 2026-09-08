import { eq } from 'drizzle-orm';

import { caseConsumers } from '../../db/schema/index.js';
import type { DatabaseExecutor } from '../../db/client.js';
import { CaseConsumerMissingError } from '../../shared/errors.js';
import type { CommunicationQueueService } from './queue-service.js';
import { getLatestTemplateVersionId } from './template-loader.js';

/**
 * Orchestrates one transactional email for a case:
 * 1. resolves the encrypted recipient from the case's consumer record,
 * 2. resolves the latest template version for the key + locale,
 * 3. enqueues the communication + outbox event in the caller's transaction.
 */
export class EmailTriggerService {
  constructor(private readonly queue: CommunicationQueueService) {}

  async trigger(
    tx: DatabaseExecutor,
    params: {
      caseId: string;
      templateKey: string;
      locale: string;
      variables: Record<string, string>;
      deduplicationKey: string;
      eventType: string;
    },
  ): Promise<void> {
    const [consumer] = await tx
      .select({
        keyVersion: caseConsumers.keyVersion,
        emailEncrypted: caseConsumers.emailEncrypted,
      })
      .from(caseConsumers)
      .where(eq(caseConsumers.caseId, params.caseId))
      .limit(1);

    if (!consumer)
      throw new CaseConsumerMissingError(`No case consumer for case ${params.caseId}.`);

    const templateVersionId = await getLatestTemplateVersionId(
      tx,
      params.templateKey,
      params.locale,
    );

    await this.queue.queue(tx, {
      caseId: params.caseId,
      templateVersionId,
      recipientKeyVersion: consumer.keyVersion,
      recipientEncrypted: consumer.emailEncrypted,
      deduplicationKey: params.deduplicationKey,
      eventType: params.eventType,
      variables: params.variables,
    });
  }
}
