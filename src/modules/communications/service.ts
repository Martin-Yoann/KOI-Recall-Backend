export interface CommunicationService {
  queueClaimConfirmation(caseId: string): Promise<string>;
}
