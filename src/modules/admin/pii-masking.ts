/**
 * PII masking for the two-tier case-detail view (ADR-0004 §2.3).
 *
 * Pure functions — no DB, no crypto. They operate on already-decrypted
 * plaintext values and return masked strings suitable for roles that lack
 * `case.detail.read_pii_raw`. The service layer calls these when the viewer's
 * {@link piiTierFor} returns `'masked'`.
 *
 * Masking is deliberately lossy and non-reversible; it must not reveal enough
 * to re-identify the consumer but should give an operator enough to tell two
 * rows apart (e.g. distinguish two orders, two addresses in different cities).
 */

/** Mask a local-part, keep the domain hint. `jane.doe@example.com` → `j***@e*****.com`. */
export function maskEmail(email: string): string {
  if (!email) return '•';
  const at = email.indexOf('@');
  if (at < 1 || at === email.length - 1) return '•';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  const firstDomain = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const maskSegment = (s: string) =>
    s.length > 1 ? `${s[0]}${'•'.repeat(Math.min(s.length - 1, 5))}` : '•';
  return `${maskSegment(local)}@${maskSegment(firstDomain)}${tld}`;
}

/** Mask a phone, keep the last 4 digits. `+15551234567` → `+1 ••• ••• 4567`. */
export function maskPhone(phone: string): string {
  if (!phone) return '•';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '•'.repeat(phone.length || 1);
  const last4 = digits.slice(-4);
  const prefix = phone.slice(0, Math.max(0, phone.length - 4));
  return prefix.length > 0 ? `${'•'.repeat(Math.min(prefix.length, 8))}${last4}` : `••••${last4}`;
}

/** Mask a personal name, keep first character. `Jane` → `J•`. Empty → `•`. */
export function maskName(name: string): string {
  if (!name) return '•';
  const trimmed = name.trim();
  if (trimmed.length === 0) return '•';
  return `${trimmed[0]}•`;
}

/** The address shape stored on case_consumers (mirrors addressSchema). */
export interface MaskableAddress {
  line1?: string | undefined;
  line2?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  postalCode?: string | undefined;
  countryCode?: string | undefined;
}

/**
 * Mask a mailing address: keep city/state/country for locality, mask the
 * street and postal code. A reviewer can tell cases apart by region without
 * seeing the street.
 */
export function maskAddress(address: MaskableAddress | null | undefined): MaskableAddress {
  if (!address) return {};
  return {
    line1: address.line1 ? '••••' : undefined,
    line2: undefined,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode ? '•••••' : undefined,
    countryCode: address.countryCode,
  };
}
