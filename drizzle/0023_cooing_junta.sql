CREATE TYPE "public"."case_escalation_category" AS ENUM('injury', 'battery_ingestion', 'legal', 'regulator', 'media', 'other');--> statement-breakpoint
CREATE TABLE "case_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"review_id" uuid,
	"category" "case_escalation_category" NOT NULL,
	"reason" text NOT NULL,
	"opened_by_staff_user_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by_staff_user_id" uuid,
	"closed_at" timestamp with time zone,
	"closure_evidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_escalations_reason_chk" CHECK (char_length("case_escalations"."reason") >= 10),
	CONSTRAINT "case_escalations_closure_chk" CHECK (("case_escalations"."closed_at" is null and "case_escalations"."closed_by_staff_user_id" is null and "case_escalations"."closure_evidence" is null)
          or ("case_escalations"."closed_at" is not null and "case_escalations"."closed_by_staff_user_id" is not null and "case_escalations"."closure_evidence" is not null))
);
--> statement-breakpoint
ALTER TABLE "case_escalations" ADD CONSTRAINT "case_escalations_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_escalations" ADD CONSTRAINT "case_escalations_review_id_reportability_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reportability_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_escalations" ADD CONSTRAINT "case_escalations_opened_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("opened_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_escalations" ADD CONSTRAINT "case_escalations_closed_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("closed_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_escalations_open_idx" ON "case_escalations" USING btree ("case_id","closed_at");