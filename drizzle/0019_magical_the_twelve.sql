ALTER TABLE "disposal_authorizations" DROP CONSTRAINT "disposal_authorizations_batch_id_disposal_evidence_batches_id_fk";
--> statement-breakpoint
ALTER TABLE "disposal_declarations" DROP CONSTRAINT "disposal_declarations_authorization_id_disposal_authorizations_id_fk";
--> statement-breakpoint
ALTER TABLE "disposal_reviews" DROP CONSTRAINT "disposal_reviews_batch_id_disposal_evidence_batches_id_fk";
--> statement-breakpoint
ALTER TABLE "disposal_authorizations" ADD CONSTRAINT "disposal_authorizations_batch_id_disposal_evidence_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."disposal_evidence_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_declarations" ADD CONSTRAINT "disposal_declarations_authorization_id_disposal_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."disposal_authorizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_reviews" ADD CONSTRAINT "disposal_reviews_batch_id_disposal_evidence_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."disposal_evidence_batches"("id") ON DELETE cascade ON UPDATE no action;