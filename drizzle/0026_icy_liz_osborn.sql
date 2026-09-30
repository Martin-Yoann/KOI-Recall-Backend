ALTER TYPE "public"."case_escalation_category" ADD VALUE 'suspected_fraud' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."case_escalation_category" ADD VALUE 'data_privacy' BEFORE 'other';--> statement-breakpoint
ALTER TABLE "reportability_reviews" ALTER COLUMN "incident_id" DROP NOT NULL;
--> statement-breakpoint
-- The review becomes case-scoped (A16): a legal, regulator or media escalation
-- owes a reportability sign-off even when the case has no incident record, so
-- the unique association moves to case_id and incident_id becomes nullable.
-- Every existing review was created through an incident, so the backfill below
-- is total — a review whose incident_id dangled could not exist, because the
-- column already carried a restrict FK. The column is added nullable, backfilled,
-- and only then tightened to NOT NULL, so a non-empty table does not fail
-- mid-migration the way "ADD COLUMN ... NOT NULL" without a default would.
ALTER TABLE "reportability_reviews" ADD COLUMN "case_id" uuid;--> statement-breakpoint
-- 0024's filed check is NOT VALID, which exempts grandfathered `filed` rows from
-- validation but still fires when they are UPDATEd — and a grandfathered row has
-- no receipt to give. The backfill below touches every row, so a database that
-- already carries such rows (any real environment) fails here. Lift the check for
-- the backfill, then restore 0024's exact definition, grandfathering intact.
ALTER TABLE "reportability_reviews" DROP CONSTRAINT IF EXISTS "reportability_reviews_filed_chk";--> statement-breakpoint
UPDATE "reportability_reviews" SET "case_id" = "incidents"."case_id" FROM "incidents" WHERE "reportability_reviews"."incident_id" = "incidents"."id";--> statement-breakpoint
ALTER TABLE "reportability_reviews" ADD CONSTRAINT "reportability_reviews_filed_chk" CHECK ("reportability_reviews"."status" <> 'filed' or ("reportability_reviews"."cpsc_reference" is not null and "reportability_reviews"."filed_at" is not null and "reportability_reviews"."filing_evidence_encrypted" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "reportability_reviews" ALTER COLUMN "case_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reportability_reviews" ADD CONSTRAINT "reportability_reviews_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reportability_reviews_case_uidx" ON "reportability_reviews" USING btree ("case_id");
