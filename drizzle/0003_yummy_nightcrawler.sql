CREATE TYPE "public"."product_identifier_type" AS ENUM('sku', 'unit_upc', 'gtin14', 'model', 'style', 'other');--> statement-breakpoint
CREATE TYPE "public"."identification_mode" AS ENUM('product_identifiers', 'purchase_evidence', 'unknown');--> statement-breakpoint
CREATE TABLE "campaign_product_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"identifier_type" "product_identifier_type" NOT NULL,
	"raw_value" varchar(160) NOT NULL,
	"normalized_value" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_product_id" uuid NOT NULL,
	"model" varchar(120) NOT NULL,
	"style" varchar(120),
	"applicable_from" date,
	"applicable_to" date,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claimed_products" ADD COLUMN "matched_variant_ids" uuid[];--> statement-breakpoint
ALTER TABLE "claimed_products" ADD COLUMN "identification_mode" "identification_mode";--> statement-breakpoint
ALTER TABLE "claimed_products" ADD COLUMN "reason_codes" text[];--> statement-breakpoint
ALTER TABLE "claimed_products" ADD COLUMN "input_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "campaign_product_identifiers" ADD CONSTRAINT "campaign_product_identifiers_variant_id_campaign_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."campaign_product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_product_variants" ADD CONSTRAINT "campaign_product_variants_campaign_product_id_campaign_products_id_fk" FOREIGN KEY ("campaign_product_id") REFERENCES "public"."campaign_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_product_identifiers_variant_type_value_uidx" ON "campaign_product_identifiers" USING btree ("variant_id","identifier_type","normalized_value");--> statement-breakpoint
CREATE INDEX "campaign_product_identifiers_lookup_idx" ON "campaign_product_identifiers" USING btree ("identifier_type","normalized_value");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_product_variants_product_model_uidx" ON "campaign_product_variants" USING btree ("campaign_product_id","model");--> statement-breakpoint
CREATE INDEX "campaign_product_variants_product_idx" ON "campaign_product_variants" USING btree ("campaign_product_id");--> statement-breakpoint
CREATE INDEX "claimed_products_matched_variants_idx" ON "claimed_products" USING gin ("matched_variant_ids");