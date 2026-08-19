CREATE TABLE "refund_export_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by_staff_user_id" uuid NOT NULL,
	"purpose" varchar(500) NOT NULL,
	"row_count" integer NOT NULL,
	"file_sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_export_batches_row_count_chk" CHECK ("refund_export_batches"."row_count" > 0),
	CONSTRAINT "refund_export_batches_sha256_chk" CHECK ("refund_export_batches"."file_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "refund_export_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"export_batch_id" uuid NOT NULL,
	"case_resolution_id" uuid NOT NULL,
	"resolution_version" integer NOT NULL,
	"row_sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_export_items_sha256_chk" CHECK ("refund_export_items"."row_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "refund_export_items_version_chk" CHECK ("refund_export_items"."resolution_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "refund_export_batches" ADD CONSTRAINT "refund_export_batches_requested_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("requested_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_export_items" ADD CONSTRAINT "refund_export_items_export_batch_id_refund_export_batches_id_fk" FOREIGN KEY ("export_batch_id") REFERENCES "public"."refund_export_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_export_items" ADD CONSTRAINT "refund_export_items_case_resolution_id_case_resolutions_id_fk" FOREIGN KEY ("case_resolution_id") REFERENCES "public"."case_resolutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refund_export_batches_created_idx" ON "refund_export_batches" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_export_items_batch_resolution_uidx" ON "refund_export_items" USING btree ("export_batch_id","case_resolution_id");--> statement-breakpoint
CREATE INDEX "refund_export_items_resolution_created_idx" ON "refund_export_items" USING btree ("case_resolution_id","created_at");