import { NotImplementedServiceError } from '../../shared/errors.js';
import type {
  BlobAccessUrl,
  PrivateBlobPort,
  UploadAuthorization,
  UploadAuthorizationRequest,
  UploadCompletion,
} from './port.js';

export class NotImplementedPrivateBlobAdapter implements PrivateBlobPort {
  authorizeClientUpload(_request: UploadAuthorizationRequest): Promise<UploadAuthorization> {
    return Promise.reject(new NotImplementedServiceError('Private Blob upload authorization'));
  }

  handleUploadCallback(_request: Request): Promise<UploadCompletion | null> {
    return Promise.reject(
      new NotImplementedServiceError('Private Blob upload callback processing'),
    );
  }

  delete(_pathname: string): Promise<void> {
    return Promise.reject(new NotImplementedServiceError('Private Blob deletion'));
  }

  createAccessUrl(_pathname: string): Promise<BlobAccessUrl> {
    return Promise.reject(new NotImplementedServiceError('Private Blob access URLs'));
  }
}
