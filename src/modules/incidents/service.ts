export interface IncidentService {
  createPendingIncident(caseId: string, details: unknown, companyObtainedAt: Date): Promise<string>;
}
