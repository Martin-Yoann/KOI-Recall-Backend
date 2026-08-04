import { NotImplementedServiceError } from '../../shared/errors.js';
import type { Ciphertext, SensitiveDataCryptoPort } from './port.js';

export class NotImplementedCryptoAdapter implements SensitiveDataCryptoPort {
  encrypt(_plaintext: string): Promise<Ciphertext> {
    return Promise.reject(new NotImplementedServiceError('Sensitive field encryption'));
  }

  decrypt(_ciphertext: Ciphertext): Promise<string> {
    return Promise.reject(new NotImplementedServiceError('Sensitive field decryption'));
  }

  lookupHash(_normalizedValue: string): Promise<string> {
    return Promise.reject(new NotImplementedServiceError('Sensitive field lookup hashing'));
  }
}
