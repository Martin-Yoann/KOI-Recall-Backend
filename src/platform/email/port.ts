export interface TransactionalEmail {
  messageKey: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSendResult {
  providerMessageId: string;
}

export interface TransactionalEmailPort {
  send(message: TransactionalEmail): Promise<EmailSendResult>;
}
