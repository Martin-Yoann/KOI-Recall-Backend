CREATE TABLE "campaign_translation_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"revision" integer NOT NULL,
	"edit_version" integer DEFAULT 1 NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"source" jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" varchar(160) NOT NULL,
	"updated_by" varchar(160) NOT NULL,
	"reviewed_by" varchar(160),
	"review_reference" varchar(2000),
	"reviewed_at" timestamp with time zone,
	"published_by" varchar(160),
	"published_at" timestamp with time zone,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_locale_chk" CHECK ("campaign_translation_revisions"."locale" in ('es-US')),
	CONSTRAINT "translation_status_chk" CHECK ("campaign_translation_revisions"."status" in ('draft','submitted','approved','changes_requested','published','superseded')),
	CONSTRAINT "translation_revision_chk" CHECK ("campaign_translation_revisions"."revision" > 0 and "campaign_translation_revisions"."edit_version" > 0),
	CONSTRAINT "translation_review_chk" CHECK ("campaign_translation_revisions"."status" not in ('approved','published','superseded') or ("campaign_translation_revisions"."reviewed_by" is not null and "campaign_translation_revisions"."reviewed_at" is not null and "campaign_translation_revisions"."review_reference" is not null))
);
--> statement-breakpoint
ALTER TABLE "campaign_translation_revisions" ADD CONSTRAINT "campaign_translation_revisions_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "translation_revision_uidx" ON "campaign_translation_revisions" USING btree ("campaign_version_id","locale","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "translation_published_uidx" ON "campaign_translation_revisions" USING btree ("campaign_version_id","locale") WHERE "campaign_translation_revisions"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "translation_working_uidx" ON "campaign_translation_revisions" USING btree ("campaign_version_id","locale") WHERE "campaign_translation_revisions"."status" in ('draft', 'submitted', 'approved');--> statement-breakpoint
CREATE INDEX "translation_version_idx" ON "campaign_translation_revisions" USING btree ("campaign_version_id");