/**
 * Legacy consumer claim lookup (`GET /v1/consumer-auth/lookup/{claimNumber}`).
 * Contract-complete definition added so the endpoint can be formally marked
 * `deprecated` in the published OpenAPI document.
 *
 * H1 (optimization plan v3): the response is trimmed to the exact §9.9
 * whitelist shared with `POST /v1/case-status-lookups` — same shape, no
 * decrypted PII, no internal status values, no refund amounts. The phone
 * query factor remains a transition-period compatibility match only;
 * consumers must migrate to the PII-free endpoint, after which this route is
 * removed (G8).
 */
export { caseStatusLookupResponseSchema as legacyConsumerClaimLookupResponseSchema } from './case-status-lookups.js';
