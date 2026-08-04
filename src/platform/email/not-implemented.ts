import { NotImplementedServiceError } from '../../shared/errors.js';
import type { EmailSendResult, TransactionalEmail, TransactionalEmailPort } from './port.js';

export class NotImplementedEmailAdapter implements TransactionalEmailPort {
  send(_message: TransactionalEmail): Promise<EmailSendResult> {
    return Promise.reject(new NotImplementedServiceError('Resend email delivery'));
  }
}
