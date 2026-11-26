# English and Spanish localization

The consumer application uses stable message IDs in `src/lib/i18n/en.json` and `es.json`. UI messages and finite status codes are separate from campaign content and user input. English sentences are never runtime translation keys. Named message parameters retain references, file names and other user values.

## Campaign content

The admin campaign page has a **Languages** tab. Staff compare the English source with manually authored Spanish fields, preview the result, save a draft, submit for review, record a review reference, approve, and publish. Both editing and workflow actions require the existing `campaign.publish` permission; viewing requires `case.queue.read`. Review references record staff decisions and do not themselves establish external regulatory approval.

Translations cover notice text, product names/descriptions, remedy names/descriptions, evidence instructions, support hours and campaign FAQ. Shared identifiers, SKU/lot data, contacts, evidence limits and eligibility rules cannot be edited through this interface.

Each revision binds to a published campaign version and a hash of its English source. Stale source and stale edit versions produce conflicts. Submitted content is immutable; revisions needing changes get a new draft. Publication supersedes the previous published revision in one transaction. Database constraints and a trigger preserve review/publication provenance. Drafts and approval records do not become public until publication. Changed English source prevents outdated Spanish content from being served.

Draft saves and every review/publication action write their cross-surface audit event through the same database transaction. Audit failure rolls back the content, status, edit version and any supersession of a prior published revision. Cache invalidation runs only after successful commit.

The public campaign response carries translation ID/revision/source version. Claim submissions separately record preferred communication locale and actual content locale/translation ID. The server validates that the translation belongs to the pinned campaign version; a compound foreign key preserves this association. Existing cases and clients remain compatible through nullable/optional fields.

Without an available Spanish campaign version, the web application shows English approved content with an explicit original-language notice while keeping UI controls in Spanish. Do not fill missing safety content using automatic translation.

## Disposal instructions and emails

Disposal instructions remain independent approved versions. The admin draft form supports English or Spanish, with the existing approval/publication workflow required for either language. The visitor is told when an approved instruction is shown in its original language.

New tasks select the newest currently effective, approved and authorizing instruction in the claim's preferred language before considering English fallback. A higher version in another language cannot override a valid matching-language instruction. Draft, withdrawn, expired, future and non-authorizing approvals remain ineligible. Existing tasks retain their pinned instruction version.

Spanish transactional email templates are defined in code. `pnpm email:setup:spanish` installs their database versions; it is an explicit deployment step, not part of a build. Email selection prefers the requested locale and safely falls back to English when templates are absent.

## Release order

1. Review and apply migrations `0030_campaign_translation_revisions.sql` and `0031_translation_case_provenance.sql` to the target database. The latter creates the composite unique index before its dependent foreign key.
2. Deploy the backend before the new admin and consumer applications, because campaign reads use the new translation table.
3. Install reviewed Spanish email templates where appropriate.
4. Author, review and publish Spanish campaign/disposal content. Deploying code does not publish untranslated drafts or establish external approval.

Local verification includes isolated PostgreSQL-compatible migration/workflow tests, catalogue/parameter coverage tests, builds, and browser checks with external writes mocked. Production migrations and template installation are not executed by these checks.
