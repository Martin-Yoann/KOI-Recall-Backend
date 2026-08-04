export interface DocumentService {
  authorizeUpload(input: unknown): Promise<unknown>;
  scheduleDraftDocumentDeletion(draftId: string, documentId: string): Promise<void>;
}
