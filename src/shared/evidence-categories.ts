/**
 * The one list of evidence categories.
 *
 * These literals used to be hand-copied into five places — the Postgres enum, two
 * Zod contracts, the blob port's union, and a mapper's row type. They drifted:
 * `disposal_evidence` was added to the Drizzle schema but never reached a
 * migration or any contract, so the schema source and the database disagreed and
 * an insert of that category failed at the database. Every consumer now derives
 * from this tuple, so adding a category is one edit that the compiler and
 * `drizzle-kit` both see.
 */
export const EVIDENCE_CATEGORIES = [
  'product_photo',
  'proof_of_purchase',
  'incident_evidence',
  'disposal_evidence',
] as const;

export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];
