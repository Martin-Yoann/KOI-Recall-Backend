import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import type { Ciphertext, SensitiveDataCryptoPort } from './port.js';

const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

const b64 = (value: Buffer): string => value.toString('base64url');

function decodeSecret(
  name: string,
  encodedValue: string,
  minimumByteLength: number,
  maximumByteLength?: number,
): Buffer {
  if (!BASE64_PATTERN.test(encodedValue)) {
    throw new Error(`${name} must be valid Base64.`);
  }

  const decoded = Buffer.from(encodedValue, 'base64');
  if (
    decoded.length < minimumByteLength ||
    (maximumByteLength !== undefined && decoded.length > maximumByteLength)
  ) {
    throw new Error(`${name} has an invalid byte length.`);
  }

  return decoded;
}

function decodeBase64url(value: string, label: string, allowEmpty = false): Buffer {
  if (
    (!allowEmpty && value.length === 0) ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    throw new Error(`Malformed ${label}.`);
  }

  return Buffer.from(value, 'base64url');
}

export class NodeSensitiveDataCrypto implements SensitiveDataCryptoPort {
  private readonly key: Buffer;
  private readonly pepper: Buffer;

  constructor(encryptionKeyBase64: string, hashPepperBase64: string) {
    this.key = decodeSecret(
      'FIELD_ENCRYPTION_KEY',
      encryptionKeyBase64,
      AES_256_KEY_BYTES,
      AES_256_KEY_BYTES,
    );
    this.pepper = decodeSecret('HASH_PEPPER', hashPepperBase64, AES_256_KEY_BYTES);
    if (this.key.equals(this.pepper)) {
      throw new Error('FIELD_ENCRYPTION_KEY and HASH_PEPPER must be distinct.');
    }
  }

  encrypt(plaintext: string): Promise<Ciphertext> {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Promise.resolve({
      keyVersion: 'v1',
      value: ['enc', 'v1', 'aes-256-gcm', b64(iv), b64(encrypted), b64(tag)].join('.'),
    });
  }

  decrypt(input: Ciphertext): Promise<string> {
    return Promise.resolve().then(() => {
      const parts = input.value.split('.');
      if (parts.length !== 6) {
        throw new Error('Malformed encrypted value envelope.');
      }

      const [prefix, version, algorithm, encodedIv, encodedBody, encodedTag] = parts as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      if (
        prefix !== 'enc' ||
        version !== input.keyVersion ||
        version !== 'v1' ||
        algorithm !== 'aes-256-gcm'
      ) {
        throw new Error('Unsupported encrypted value envelope.');
      }

      const iv = decodeBase64url(encodedIv, 'encryption IV');
      const body = decodeBase64url(encodedBody, 'encrypted body', true);
      const tag = decodeBase64url(encodedTag, 'authentication tag');
      if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
        throw new Error('Malformed encrypted value envelope.');
      }

      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    });
  }

  lookupHash(normalizedValue: string): Promise<string> {
    return Promise.resolve(
      createHmac('sha256', this.pepper).update(normalizedValue, 'utf8').digest('hex'),
    );
  }
}
