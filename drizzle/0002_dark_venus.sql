ALTER TABLE "document_uploads" ADD COLUMN "category_slot" integer;--> statement-breakpoint
WITH "ranked_uploads" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "draft_id", "category"
			ORDER BY "created_at", "id"
		) AS "slot"
	FROM "document_uploads"
	WHERE "draft_id" IS NOT NULL
		AND "upload_status" IN ('authorized', 'uploaded', 'verified', 'linked')
)
UPDATE "document_uploads"
SET "category_slot" = "ranked_uploads"."slot"
FROM "ranked_uploads"
WHERE "document_uploads"."id" = "ranked_uploads"."id";--> statement-breakpoint
CREATE UNIQUE INDEX "document_uploads_draft_category_slot_uidx" ON "document_uploads" USING btree ("draft_id","category","category_slot");--> statement-breakpoint
ALTER TABLE "document_uploads" ADD CONSTRAINT "document_uploads_category_slot_chk" CHECK ("document_uploads"."category_slot" is null or "document_uploads"."category_slot" > 0);
