import { createHash, randomBytes } from 'node:crypto';

const CASE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON only accepts finite numbers.');
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nestedValue]) => [key, canonicalize(nestedValue)]),
    );
  }

  throw new TypeError('Canonical JSON only accepts JSON values.');
}

function randomToken(length: number): string {
  return Array.from(randomBytes(length), (byte) => CASE_ALPHABET[byte & 31]).join('');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeAddress(value: Record<string, string | undefined>): string {
  const normalized = Object.entries(value).reduce<Record<string, string>>(
    (result, [key, fieldValue]) => {
      if (fieldValue !== undefined) {
        result[key] = key === 'countryCode' ? fieldValue.toUpperCase() : fieldValue.trim();
      }
      return result;
    },
    {},
  );

  return canonicalJson(normalized);
}

export function normalizeOrderNumber(value: string): string {
  return value.trim().toUpperCase();
}

export function hashCanonicalRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function generateCaseReference(): string {
  return `KOI-${randomToken(4)}-${randomToken(8)}`;
}
