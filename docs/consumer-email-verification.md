# Account-linked claim access

Registration and a matching email address are not proof of mailbox ownership. Both `/v1/consumer-auth/claims` and `/v1/consumer-auth/claims/:claimNumber` require an active consumer session with a server-side `consumer_sessions.email_verified_at` value. Otherwise they return 403 with problem type `email-verification-required`, before querying or decrypting historical claims. Anonymous claim-status lookup remains unchanged.

## Verification flow

1. The signed-in user explicitly requests an email with `POST /v1/consumer-auth/email-verification`, bearer authorization and `{ "locale": "en-US" }` (or `es-US`). The recipient is always the authenticated account's canonical email; request data cannot choose another mailbox or destination URL.
2. The service stores only the SHA-256 hash of a random 32-byte token. It binds the proof to the requesting user and exact session, with a 20-minute expiry. The token is delivered through the configured transactional email port; it is never returned by the API.
3. The email links to the configured consumer website's `/verify-email#token=…` page. The fragment is removed on page initialization, excluded from server logs, and not persisted to browser storage. Opening the page does not consume the proof: the visitor must explicitly confirm.
4. `POST /v1/consumer-auth/email-verification/confirm` requires the same bearer session and `{ "token": "…" }`. Session validity, user/session binding, expiry and one-use checks occur in one transaction; consumption and marking the session verified commit together. Wrong-session attempts do not consume the legitimate proof.
5. `GET /v1/consumer-auth/me` returns `user.claimsAccessVerified` for the current session. The frontend uses it to show verification guidance; the server independently enforces authorization on every private claim read. Client fields cannot grant access.

Verification applies to one login session, not to all sessions of an account. Other existing sessions and future logins remain unverified. This prevents a proof performed in one browser from upgrading a different session that an impersonator may already possess. Existing sessions receive a nullable, initially empty verification field during migration; none are grandfathered in.

Requests have a per-account 60-second resend cooldown, serialized across sessions, plus an IP-scoped route quota. Resending invalidates earlier unused links for that session. Delivery errors fail closed and do not disclose provider details. Authentication responses use `Cache-Control: no-store`. The frontend gates account overview, claim lists and both detail entry points, while keeping guest status lookup available.

## Release and testing

Apply migration `0032_consumer_session_email_verification.sql` before deploying the backend. Deploy the frontend with its confirmation page and verification gate afterward. Existing `RESEND_API_KEY`, `RESEND_FROM_EMAIL` and `CONSUMER_WEB_BASE_URL` configure delivery; a missing/unavailable email service cannot grant claim access.

Regression coverage uses the real HTTP routes, an isolated PostgreSQL-compatible database and a captured email port. It includes the original impersonation reproduction, list/detail denial before proof, valid ownership, different account/session denial, new-login isolation, expiry, replay, concurrency, logout, resend, spoofed profile fields and delivery failures. No real verification emails or test claims are sent to production by these tests.
