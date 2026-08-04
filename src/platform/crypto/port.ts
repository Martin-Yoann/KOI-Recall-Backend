export interface Ciphertext {
  keyVersion: string;
  value: string;
}

export interface SensitiveDataCryptoPort {
  encrypt(plaintext: string): Promise<Ciphertext>;
  decrypt(ciphertext: Ciphertext): Promise<string>;
  lookupHash(normalizedValue: string): Promise<string>;
}
