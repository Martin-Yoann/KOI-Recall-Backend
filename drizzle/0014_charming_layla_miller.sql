CREATE TABLE "template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_key" varchar(100) NOT NULL,
	"locale" varchar(10) NOT NULL,
	"version" integer NOT NULL,
	"subject" text NOT NULL,
	"html_body" text NOT NULL,
	"text_body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "communications" ALTER COLUMN "template_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "template_version_id" uuid;--> statement-breakpoint
ALTER TABLE "case_resolutions" ADD COLUMN "tracking_number" text;--> statement-breakpoint
ALTER TABLE "case_resolutions" ADD COLUMN "shipped_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_template_lookup" ON "template_versions" USING btree ("template_key","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_template_version" ON "template_versions" USING btree ("template_key","locale","version");--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_template_version_id_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."template_versions"("id") ON DELETE restrict ON UPDATE no action;