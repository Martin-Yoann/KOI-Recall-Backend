/**
 * Audit metadata is a narrow, broadly readable record — not a scratch pad.
 *
 * `admin_audit_events.metadata` can be read by every internal role, so whatever is
 * written here is visible company-wide: to people with no business reading a note
 * about a consumer, a regulator or a colleague. Operator prose therefore belongs on
 * the record it describes — the transition, the hold, the review, the export batch —
 * where the read path is guarded by the permissions for that thing. Written here as
 * well, it was a second copy with no guard at all, which is what this module closes.
 *
 * The cap below is a backstop rather than the rule. Prose is kept out by not putting
 * it in, one call site at a time; the cap catches what arrives anyway — through a
 * spread, or through a field nobody re-read — and leaves a marker in its place, so an
 * auditor sees that something was withheld instead of reading a row that looks
 * complete.
 */

/**
 * The keys an audit event may carry, named one by one.
 *
 * The write contract is a whitelist rather than `Record<string, unknown>` so that adding
 * a key is a deliberate act: this type has no index signature, so a key that is not named
 * here fails to compile at every call site until someone decides to name it. That is the
 * difference between "no prose in a broadly readable table" being a rule and being a
 * habit — the habit is what let seven call sites write whole sentences into it.
 *
 * Two entries are worth a second look when this list is next revised:
 *
 * - `fileName` is the document's name as the consumer uploaded it, so it can carry a
 *   person's name. It stays because the trail is not a new channel for it: every role
 *   that can read the audit trail can also read the case's document list, which shows
 *   the same names. Removing the key here would shorten a security trail without
 *   closing anything; closing the channel means changing what the document list shows.
 * - `via` remains because it distinguishes *how* an action reached the API (e.g. a
 *   since-removed legacy path) on rows history still holds; it is a short enum-like
 *   word, not caller prose.
 */
export const AUDIT_METADATA_KEYS = [
  'assignee',
  'authorizationId',
  'authorizesConsumerDisposal',
  'campaignProductId',
  'campaignVersionId',
  'caseReference',
  'category',
  'decision',
  'eligibilityStatus',
  'externalReference',
  'fields',
  'fileName',
  'fileSha256',
  'filedAt',
  'forced',
  'materialType',
  'measure',
  'nextStatus',
  'outcome',
  'quantity',
  'reason',
  'reasonCode',
  'resolutionId',
  'resolutionType',
  'retentionDays',
  'role',
  'rowCount',
  'scope',
  'status',
  'suspendedAuthorizations',
  'trackingNumber',
  'versionNumber',
  'via',
] as const;

export type AuditMetadataKey = (typeof AUDIT_METADATA_KEYS)[number];

/**
 * A value the trail may carry: a scalar, a count, or a list of field names.
 *
 * `undefined` is allowed so a caller can pass a value it may not have without the
 * conditional-spread dance at every call site; `sanitizeAuditMetadata` drops those
 * entries, so "absent" and "undefined" mean the same thing on the way in. What this
 * type does *not* allow is an arbitrary key — that is the point of the whitelist.
 */
export type AuditMetadataValue = string | number | boolean | null | readonly string[] | undefined;

/** What a caller may pass as audit metadata. */
export type AuditMetadata = Partial<Record<AuditMetadataKey, AuditMetadataValue>>;

/** Long enough for a hash, a URL, an identifier or an enum; too short for a sentence. */
export const AUDIT_METADATA_VALUE_MAX_CHARS = 200;

/** What replaces a value that is too long for the audit trail. */
export const AUDIT_METADATA_WITHHELD = '[withheld: too long for the audit trail]';

function capValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > AUDIT_METADATA_VALUE_MAX_CHARS ? AUDIT_METADATA_WITHHELD : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => capValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    // Nothing today stores an object here. If something starts to, the cap applies to
    // its serialized size rather than to a shape nobody has defined.
    const serialized = JSON.stringify(value);
    return serialized.length > AUDIT_METADATA_VALUE_MAX_CHARS ? AUDIT_METADATA_WITHHELD : value;
  }
  return value;
}

/**
 * Returns the metadata as it will be stored: explicit `undefined`s dropped, and any
 * value too long for the audit trail replaced by a visible marker.
 */
export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    sanitized[key] = capValue(value);
  }
  return sanitized;
}
