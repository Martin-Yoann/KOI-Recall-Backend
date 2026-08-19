ALTER TABLE "campaign_versions" ADD COLUMN "privacy_notice_version" varchar(80);--> statement-breakpoint
ALTER TABLE "campaign_versions" ADD COLUMN "privacy_notice_url" text;--> statement-breakpoint

CREATE TYPE "public"."case_resolution_status" AS ENUM('requested', 'approved', 'externally_completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."case_resolution_type" AS ENUM('replacement', 'refund');--> statement-breakpoint
CREATE TABLE "case_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"requested_type" "case_resolution_type",
	"requested_remedy_option_id" uuid,
	"approved_type" "case_resolution_type",
	"status" "case_resolution_status" DEFAULT 'requested' NOT NULL,
	"refund_amount_minor" integer,
	"currency" varchar(3),
	"approved_by_staff_user_id" uuid,
	"approved_at" timestamp with time zone,
	"approval_note_encrypted" text,
	"approval_note_key_version" varchar(40),
	"external_reference" varchar(160),
	"completion_note_encrypted" text,
	"completion_note_key_version" varchar(40),
	"completed_by_staff_user_id" uuid,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_resolutions_version_chk" CHECK ("case_resolutions"."version" > 0),
	CONSTRAINT "case_resolutions_currency_chk" CHECK ("case_resolutions"."currency" is null or "case_resolutions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "case_resolutions_approval_chk" CHECK ("case_resolutions"."status" not in ('approved', 'externally_completed')
          or ("case_resolutions"."approved_type" is not null
              and "case_resolutions"."approved_by_staff_user_id" is not null
              and "case_resolutions"."approved_at" is not null)),
	CONSTRAINT "case_resolutions_refund_chk" CHECK ("case_resolutions"."approved_type" is distinct from 'refund'
          or ("case_resolutions"."refund_amount_minor" is not null
              and "case_resolutions"."refund_amount_minor" > 0
              and "case_resolutions"."currency" is not null)),
	CONSTRAINT "case_resolutions_replacement_chk" CHECK ("case_resolutions"."approved_type" is distinct from 'replacement'
          or ("case_resolutions"."refund_amount_minor" is null and "case_resolutions"."currency" is null)),
	CONSTRAINT "case_resolutions_completion_chk" CHECK ("case_resolutions"."status" <> 'externally_completed'
          or ("case_resolutions"."completed_by_staff_user_id" is not null and "case_resolutions"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "case_resolutions" ADD CONSTRAINT "case_resolutions_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_resolutions" ADD CONSTRAINT "case_resolutions_requested_remedy_option_id_campaign_remedy_options_id_fk" FOREIGN KEY ("requested_remedy_option_id") REFERENCES "public"."campaign_remedy_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_resolutions" ADD CONSTRAINT "case_resolutions_approved_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("approved_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_resolutions" ADD CONSTRAINT "case_resolutions_completed_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("completed_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_resolutions_case_uidx" ON "case_resolutions" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_resolutions_approved_idx" ON "case_resolutions" USING btree ("approved_type","status","approved_at");--> statement-breakpoint
CREATE INDEX "case_resolutions_status_updated_idx" ON "case_resolutions" USING btree ("status","updated_at");