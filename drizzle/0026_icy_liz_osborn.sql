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
UPDATE "reportability_reviews" SET "case_id" = "incidents"."case_id" FROM "incidents" WHERE "reportability_reviews"."incident_id" = "incidents"."id";--> statement-breakpoint
ALTER TABLE "reportability_reviews" ALTER COLUMN "case_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reportability_reviews" ADD CONSTRAINT "reportability_reviews_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reportability_reviews_case_uidx" ON "reportability_reviews" USING btree ("case_id");
