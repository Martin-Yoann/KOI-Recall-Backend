ALTER TABLE "incidents" ADD COLUMN "failure_mode" varchar(40);--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "injury_description_key_version" varchar(40);--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "injury_description_encrypted" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "medical_treatment_received" varchar(16);--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "unit_type" varchar(16);--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_injury_description_pair_chk" CHECK (("incidents"."injury_description_key_version" is null) = ("incidents"."injury_description_encrypted" is null));