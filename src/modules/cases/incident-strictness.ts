import type { ClaimSubmissionRequest } from '../../contracts/claims.js';
import { ClaimValidationError } from '../../shared/errors.js';

type IncidentDetails = NonNullable<ClaimSubmissionRequest['incidentDetails']>;

/**
 * Fields that become required once INCIDENT_STRICT_VALIDATION is on.
 *
 * The switch is read here rather than in the Zod contract on purpose: the
 * contract is also the source of the published OpenAPI document, so putting a
 * deploy-time flag inside it would make the public schema depend on the
 * environment. Keeping the rule in the service layer means the same submitted
 * payload is rejected identically on every instance regardless of which
 * artifact is serving it.
 */
const STRICT_REQUIRED_FIELDS: readonly { field: keyof IncidentDetails; label: string }[] = [
  { field: 'usedAsIntended', label: 'usedAsIntended' },
  { field: 'unitType', label: 'unitType' },
  { field: 'failureMode', label: 'failureMode' },
  { field: 'medicalTreatmentReceived', label: 'medicalTreatmentReceived' },
];

/**
 * Enforces the strict-stage incident contract.
 *
 * Scope is deliberately narrow:
 *  - Only `incidentAnswer === 'yes'` is enforced. An `unsure` answer is the
 *    consumer saying they cannot confirm the details, so demanding them would
 *    block exactly the submissions the compliance queue most needs to see.
 *  - Only *requiredness* is enforced. Cross-field contradictions are rejected
 *    by the contract in every stage, so they are not repeated here.
 *  - No-op when the flag is off, which is the default: this is stage 1 of the
 *    staged rollout, where the new fields are accepted but optional.
 */
export function assertIncidentDetailsCompleteness(
  body: ClaimSubmissionRequest,
  strictValidationEnabled: boolean,
): void {
  if (!strictValidationEnabled) return;
  if (body.incidentAnswer !== 'yes') return;

  const details = body.incidentDetails;
  if (!details) return;

  const missing = STRICT_REQUIRED_FIELDS.filter(({ field }) => details[field] === undefined).map(
    ({ label }) => label,
  );

  const hasInjury =
    details.eventTypes?.some((type) => type === 'injury' || type === 'illness') ?? false;
  if (hasInjury && details.injuryDescription === undefined) {
    missing.push('injuryDescription');
  }

  if (missing.length > 0) {
    throw new ClaimValidationError(
      `Structured incident details are required for a confirmed incident: ${missing.join(', ')}.`,
    );
  }
}
