ALTER TABLE "campaign_versions" ADD COLUMN "published_by" varchar(160);--> statement-breakpoint
ALTER TABLE "campaign_versions" ADD COLUMN "approvals" jsonb DEFAULT '[]'::jsonb;