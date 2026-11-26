ALTER TABLE "recall_cases" ADD COLUMN "content_locale" varchar(16);--> statement-breakpoint
ALTER TABLE "recall_cases" ADD COLUMN "content_translation_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "translation_case_reference_uidx" ON "campaign_translation_revisions" USING btree ("id","campaign_version_id","locale");--> statement-breakpoint
ALTER TABLE "recall_cases" ADD CONSTRAINT "recall_cases_translation_fk" FOREIGN KEY ("content_translation_id","campaign_version_id","content_locale") REFERENCES "public"."campaign_translation_revisions"("id","campaign_version_id","locale") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_translation_revisions" ADD CONSTRAINT "translation_publish_chk" CHECK ("campaign_translation_revisions"."status" not in ('published','superseded') or ("campaign_translation_revisions"."published_by" is not null and "campaign_translation_revisions"."published_at" is not null));--> statement-breakpoint
ALTER TABLE "recall_cases" ADD CONSTRAINT "recall_cases_content_language_chk" CHECK ("recall_cases"."content_translation_id" is null or "recall_cases"."content_locale" is not null);--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_campaign_translation_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'Reviewed translation history cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.campaign_version_id, NEW.locale, NEW.revision, NEW.source_hash, NEW.source, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.campaign_version_id, OLD.locale, OLD.revision, OLD.source_hash, OLD.source, OLD.created_by, OLD.created_at)
    THEN RAISE EXCEPTION 'Translation source binding is immutable'; END IF;
  IF OLD.status <> 'draft' AND NEW.content IS DISTINCT FROM OLD.content
    THEN RAISE EXCEPTION 'Submitted translation content is immutable; create a new revision'; END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('draft','submitted','changes_requested')) OR
    (OLD.status = 'submitted' AND NEW.status IN ('approved','changes_requested')) OR
    (OLD.status = 'approved' AND NEW.status IN ('published','changes_requested')) OR
    (OLD.status = 'published' AND NEW.status = 'superseded')
  ) THEN RAISE EXCEPTION 'Invalid translation workflow transition'; END IF;
  IF OLD.published_at IS NOT NULL AND
    (NEW.published_at, NEW.published_by, NEW.reviewed_at, NEW.reviewed_by, NEW.review_reference)
    IS DISTINCT FROM (OLD.published_at, OLD.published_by, OLD.reviewed_at, OLD.reviewed_by, OLD.review_reference)
    THEN RAISE EXCEPTION 'Published translation provenance is immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER campaign_translation_revision_guard BEFORE UPDATE OR DELETE ON campaign_translation_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_campaign_translation_revision();
