import { NotImplementedServiceError } from '../../shared/errors.js';
import type { PrivateBlobPort, UploadAuthorization, UploadAuthorizationRequest } from './port.js';

export class NotImplementedPrivateBlobAdapter implements PrivateBlobPort {
  authorizeClientUpload(_request: UploadAuthorizationRequest): Promise<UploadAuthorization> {
    return Promise.reject(new NotImplementedServiceError('Private Blob upload authorization'));
  }

  delete(_pathname: string): Promise<void> {
    return Promise.reject(new NotImplementedServiceError('Private Blob deletion'));
  }
}
