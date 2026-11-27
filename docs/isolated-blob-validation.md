# Isolated Vercel private Blob validation

The 2026-11-27 check used a new empty private Blob store and a separate temporary Vercel project. Neither resource was connected to the business projects. A 68-byte PNG was uploaded using the application's scoped client-token adapter. The check confirmed:

- The real provider stored the expected bytes and reported their size.
- Anonymous retrieval failed, while the application's signed access URL returned the exact bytes.
- Vercel sent a real completion callback; the receiver validated it and saved the original body and headers as a private test receipt.
- The application's `VercelBlobAdapter` verified that real receipt and reconstructed the expected document ID, object pathname and authoritative size. Modifying the payload while retaining its signature was rejected.
- The image and receipt were deleted, and the isolated store was empty before cleanup of the temporary resources.

This validates cloud storage and the application adapter, including a real provider signature. It does not claim a continuously forwarded provider callback into a cloud application/database, or malware scanning. Native database reconciliation and cleanup were exercised separately in the local file lifecycle test.

## Repeat the check

1. Create an empty **private** test store and a separate temporary Vercel project. Do not connect the store to a business project. Install the same `@vercel/blob` version as this repository.
2. Deploy `scripts/fixtures/blob-callback.js` as `api/callback.js` in that temporary project, with its test-store `BLOB_READ_WRITE_TOKEN`. The endpoint accepts only completion callbacks and stores receipts privately.
3. Configure `ALLOW_CLOUD_BLOB_TESTS=true`, `BLOB_TEST_STORE_ID`, `BLOB_TEST_CALLBACK_URL`, and either `BLOB_TEST_READ_WRITE_TOKEN` or `BLOB_TEST_ENV_FILE` pointing at the temporary project's dotenv file. Credentials must never be committed.
4. Run `pnpm test:blob:cloud`. An optional `BLOB_TEST_REPORT` selects the report path. The default report is under `.local-storage`.
5. Confirm that the store is empty, then delete the temporary project and store. Remove any downloaded credentials. This script never empties a store: it deletes only its own test image and receipt, and refuses a nonempty store before uploading.
