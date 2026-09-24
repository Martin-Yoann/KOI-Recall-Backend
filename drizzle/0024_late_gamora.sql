-- The filing receipt column did not exist before this migration, so every review that
-- is already `filed` has no receipt and never can have one: inventing one for a filing
-- made months ago would be fabricating the basis of a safety decision. The constraint is
-- therefore added NOT VALID — enforced for every new and updated row from here on, with
-- existing rows grandfathered. Validating it later requires a backfill that only a human
-- with the original filings can supply, and a deliberate `VALIDATE CONSTRAINT` step.
ALTER TABLE "reportability_reviews" ADD COLUMN "filing_evidence_encrypted" text;--> statement-breakpoint
ALTER TABLE "reportability_reviews" DROP CONSTRAINT IF EXISTS "reportability_reviews_filed_chk";--> statement-breakpoint
ALTER TABLE "reportability_reviews" ADD CONSTRAINT "reportability_reviews_filed_chk" CHECK ("reportability_reviews"."status" <> 'filed' or ("reportability_reviews"."cpsc_reference" is not null and "reportability_reviews"."filed_at" is not null and "reportability_reviews"."filing_evidence_encrypted" is not null)) NOT VALID;
