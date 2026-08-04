export interface ClaimSubmissionCommand {
  campaignSlug: string;
  idempotencyKey: string;
  body: unknown;
}

export interface CaseService {
  submit(command: ClaimSubmissionCommand): Promise<unknown>;
}
