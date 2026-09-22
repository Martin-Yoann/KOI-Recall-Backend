CREATE TABLE "disposal_authorization_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authorization_id" uuid NOT NULL,
	"campaign_product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposal_authorization_items_quantity_chk" CHECK ("disposal_authorization_items"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "disposal_authorization_items" ADD CONSTRAINT "disposal_authorization_items_authorization_id_disposal_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."disposal_authorizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_authorization_items" ADD CONSTRAINT "disposal_authorization_items_campaign_product_id_campaign_products_id_fk" FOREIGN KEY ("campaign_product_id") REFERENCES "public"."campaign_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "disposal_authorization_items_uidx" ON "disposal_authorization_items" USING btree ("authorization_id","campaign_product_id");