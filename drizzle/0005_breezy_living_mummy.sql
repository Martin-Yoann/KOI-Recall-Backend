CREATE TYPE "public"."purchase_corroboration" AS ENUM('verified', 'partial', 'not_provided', 'conflict');--> statement-breakpoint
ALTER TABLE "claimed_products" ADD COLUMN "purchase_evidence_encrypted" text;--> statement-breakpoint
ALTER TABLE "claimed_products" ADD COLUMN "purchase_evidence_key_version" varchar(40);--> statement-breakpoint
ALTER TABLE "claimed_products" ADD COLUMN "purchase_evidence_lookup_hash" varchar(128);--> statement-breakpoint
ALTER TABLE "claimed_products" ADD COLUMN "purchase_corroboration" "purchase_corroboration";--> statement-breakpoint
ALTER TABLE "claimed_products" ADD COLUMN "risk_flags" text[];