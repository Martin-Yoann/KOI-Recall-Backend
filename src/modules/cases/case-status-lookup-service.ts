import type { CaseStatusLookupResponse } from '../../contracts/toc.js';

/**
 * Public, PII-free case status lookup keyed on the (caseReference, email)
 * pair. This is an authentication, not a search: both "unknown reference" and
 * "email mismatch" collapse into the same `null`, so callers can never tell
 * them apart and enumeration of references is useless without the email.
 */
export interface CaseStatusLookupService {
  lookup(caseReference: string, email: string): Promise<CaseStatusLookupResponse | null>;
}
