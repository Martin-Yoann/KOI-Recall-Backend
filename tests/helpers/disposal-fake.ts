import type { DisposalService } from '../../src/modules/disposal/service.js';

/**
 * A disposal service that refuses everything.
 *
 * `AdminTransactionServices` is a closed shape, so every test that builds a
 * transaction runner has to supply one. A refusing stub is the honest default:
 * tests that do not exercise disposal should fail loudly if they reach it, not
 * silently succeed against a permissive fake.
 */
export function makeDisposalFake(): DisposalService {
  const refuse = (what: string) => () =>
    Promise.reject(new Error(`Disposal stub: ${what} is not wired in this test.`));
  return {
    createTaskForSubmission: () => Promise.resolve(null),
    getTaskForVisitor: () => Promise.resolve(null),
    getTaskForAdmin: () => Promise.resolve(null),
    confirmEligibility: refuse('confirmEligibility'),
    confirmProductAffected: refuse('confirmProductAffected'),
    submitEvidenceBatch: refuse('submitEvidenceBatch'),
    reviewBatch: refuse('reviewBatch'),
    placeHold: refuse('placeHold'),
    releaseHold: refuse('releaseHold'),
    issueAuthorization: refuse('issueAuthorization'),
    recordDeclaration: refuse('recordDeclaration'),
    withdrawInstruction: refuse('withdrawInstruction'),
    createInstructionVersion: refuse('createInstructionVersion'),
    recordInstructionApproval: refuse('recordInstructionApproval'),
    publishInstructionVersion: refuse('publishInstructionVersion'),
    listInstructionVersions: () => Promise.resolve([]),
    listQueue: () => Promise.resolve([]),
  };
}
