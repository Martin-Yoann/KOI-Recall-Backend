# Campaign DB Adapter Hardening Design

Date: 2026-08-05
Branch: `feat/campaign-db-adapter`
Status: Approved for implementation

## Goal

Close the three review findings in the database-backed public Campaign endpoint:

1. Prevent a Campaign from publishing a version owned by another Campaign.
2. Prevent database or service values that violate the public response contract from returning HTTP 200.
3. Map PostgreSQL connection and availability failures to HTTP 503 even when errors use SQLSTATE codes or nested causes.

The public endpoint path and successful response shape remain unchanged.

## Design

### Campaign-version ownership

Use defense in depth.

At the database layer:

- Add a unique key on `campaign_versions(campaign_id, id)`.
- Replace the single-column `recall_campaigns.published_version_id` foreign key with a composite foreign key from `recall_campaigns(id, published_version_id)` to `campaign_versions(campaign_id, id)`.
- Use the default `NO ACTION` deletion behavior. A published version must be unlinked before it can be deleted; deleting a Campaign still removes the referencing Campaign row as part of the same operation.
- Generate a new Drizzle migration rather than rewriting the existing initial migration.

At the service layer, the published-version query must also require `campaign_versions.campaign_id = campaign.id`. This protects reads if constraints are temporarily absent, disabled, or not yet applied.

### Public response validation

Keep `campaignResponseSchema` as the single public contract. Before returning HTTP 200, parse `{ campaign }` with this schema and return the parsed value. Invalid service or database output throws into the existing application error handler and becomes standard `500 application/problem+json`; invalid values must never be labeled as a successful contract-compliant response.

This validation belongs at the HTTP boundary so every present or future `CampaignService` implementation receives the same protection.

### Dependency error classification

Replace the one-level error inspection with bounded graph traversal over `cause` and aggregate `errors`, using a visited set to avoid cycles.

Classify these as dependency connection/availability failures:

- Existing network error codes such as `ECONNREFUSED`, `ECONNRESET`, and `ETIMEDOUT`.
- PostgreSQL SQLSTATE class `08` connection exceptions.
- `57P01`, `57P02`, and `57P03` for shutdown or cannot-connect states.
- `53300` for exhausted connection slots.

Do not classify authentication, authorization, query, schema, or constraint errors as 503; they remain 500 because retrying the same request cannot safely resolve them.

## Test Strategy

Follow red-green-refactor separately for each behavior:

1. Add a service query regression test proving the version lookup includes Campaign ownership.
2. Add schema/migration assertions for the composite unique key and foreign key.
3. Add an HTTP test where an invalid Campaign service result produces 500 instead of 200.
4. Add error-classifier tests for SQLSTATE `08006`, shutdown codes, nested causes, aggregate errors, and a non-connection SQLSTATE control.

After targeted tests pass, run:

- Full Vitest suite.
- Opt-in local PostgreSQL integration suite.
- TypeScript typecheck.
- ESLint.
- Prettier on branch-owned files.
- OpenAPI and Drizzle checks through the project build.

## Migration and Compatibility

Adding the composite foreign key validates existing data. Migration failure therefore reveals an existing cross-Campaign pointer instead of silently preserving unsafe data. The currently seeded demo Campaign is expected to satisfy the relationship.

No public API, seed identifiers, locale behavior, or non-Campaign endpoint behavior changes in this work.
