ALTER TABLE "recall_campaigns" DROP CONSTRAINT "recall_campaigns_published_version_id_campaign_versions_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_versions_campaign_id_id_uidx" ON "campaign_versions" USING btree ("campaign_id","id");--> statement-breakpoint
ALTER TABLE "recall_campaigns" ADD CONSTRAINT "recall_campaigns_published_version_owner_fk" FOREIGN KEY ("id","published_version_id") REFERENCES "public"."campaign_versions"("campaign_id","id") ON DELETE no action ON UPDATE no action;
