import type { ClaimSubmissionRequest, ClaimSubmissionResponse } from '../../contracts/toc.js';

export interface ClaimSubmissionCommand {
  campaignSlug: string;
  idempotencyKey: string;
  body: ClaimSubmissionRequest;
}

export interface CaseService {
  submit(command: ClaimSubmissionCommand): Promise<ClaimSubmissionResponse>;
}
