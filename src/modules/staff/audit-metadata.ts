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
