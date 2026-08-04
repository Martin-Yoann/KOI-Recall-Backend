CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'scheduled', 'active', 'paused', 'closed');--> statement-breakpoint
CREATE TYPE "public"."campaign_version_status" AS ENUM('draft', 'published', 'retired');--> statement-breakpoint
CREATE TYPE "public"."claim_draft_status" AS ENUM('active', 'submitted', 'expired', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."communication_status" AS ENUM('queued', 'sending', 'sent', 'delivered', 'bounced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."document_upload_status" AS ENUM('authorized', 'uploaded', 'verified', 'linked', 'rejected', 'deletion_pending', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."evidence_category" AS ENUM('product_photo', 'proof_of_purchase', 'incident_evidence');--> statement-breakpoint
CREATE TYPE "public"."lot_eligibility_status" AS ENUM('affected', 'not_affected', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."malware_scan_status" AS ENUM('pending', 'clean', 'infected', 'failed', 'not_run');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'succeeded', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."product_check_result" AS ENUM('potential_match', 'not_matched', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."recall_case_status" AS ENUM('submitted', 'triage', 'under_review', 'need_info', 'approved', 'rejected', 'duplicate', 'withdrawn', 'closure_review', 'closed');--> statement-breakpoint
CREATE TYPE "public"."recall_case_subtype" AS ENUM('standard', 'injury_hazard');--> statement-breakpoint
CREATE TYPE "public"."reportability_review_status" AS ENUM('pending', 'filed', 'documented_non_reportable');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('received', 'processing', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "campaign_evidence_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"category" "evidence_category" NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"minimum_files" integer DEFAULT 0 NOT NULL,
	"maximum_files" integer DEFAULT 1 NOT NULL,
	"allowed_mime_types" text[] NOT NULL,
	"maximum_file_size_bytes" integer NOT NULL,
	"instructions" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_evidence_requirements_count_chk" CHECK ("campaign_evidence_requirements"."minimum_files" >= 0 and "campaign_evidence_requirements"."maximum_files" >= "campaign_evidence_requirements"."minimum_files"),
	CONSTRAINT "campaign_evidence_requirements_size_chk" CHECK ("campaign_evidence_requirements"."maximum_file_size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "campaign_localizations" (
	"campaign_version_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"title" varchar(240) NOT NULL,
	"summary" text NOT NULL,
	"hazard" text NOT NULL,
	"immediate_action" text NOT NULL,
	"remedy_summary" text NOT NULL,
	"support_email" varchar(254) NOT NULL,
	"support_phone" varchar(40) NOT NULL,
	"support_hours" varchar(200) NOT NULL,
	"faq" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_localizations_pk" PRIMARY KEY("campaign_version_id","locale")
);
--> statement-breakpoint
CREATE TABLE "campaign_message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"template_type" varchar(80) NOT NULL,
	"version" integer NOT NULL,
	"subject" varchar(240) NOT NULL,
	"html_body" text NOT NULL,
	"text_body" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_message_templates_positive_version_chk" CHECK ("campaign_message_templates"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "campaign_product_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_product_id" uuid NOT NULL,
	"lot_code" varchar(80) NOT NULL,
	"date_code" varchar(40) NOT NULL,
	"eligibility_status" "lot_eligibility_status" DEFAULT 'affected' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"sku" varchar(120) NOT NULL,
	"brand" varchar(160) NOT NULL,
	"name" varchar(240) NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_remedy_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"code" varchar(60) NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"requires_mailing_address" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "campaign_version_status" DEFAULT 'draft' NOT NULL,
	"schema_version" varchar(40) DEFAULT 'phase1-v1' NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_versions_positive_version_chk" CHECK ("campaign_versions"."version_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "case_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"consent_type" varchar(80) NOT NULL,
	"text_version" varchar(80) NOT NULL,
	"accepted" boolean NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" varchar(128),
	"user_agent_hash" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_consents_accepted_chk" CHECK ("case_consents"."accepted" = true)
);
--> statement-breakpoint
CREATE TABLE "case_consumers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"key_version" varchar(40) NOT NULL,
	"first_name_encrypted" text NOT NULL,
	"last_name_encrypted" text NOT NULL,
	"email_encrypted" text NOT NULL,
	"email_lookup_hash" varchar(128) NOT NULL,
	"phone_encrypted" text,
	"address_encrypted" text NOT NULL,
	"address_lookup_hash" varchar(128) NOT NULL,
	"country_code" varchar(2) DEFAULT 'US' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"actor_type" varchar(40) DEFAULT 'system' NOT NULL,
	"actor_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"status" "claim_draft_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"submitted_case_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claimed_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"campaign_product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"shape" varchar(80) NOT NULL,
	"flavor" varchar(80) NOT NULL,
	"lot_code" varchar(80) NOT NULL,
	"date_code" varchar(40) NOT NULL,
	"purchase_channel" varchar(40) NOT NULL,
	"purchase_date" date,
	"order_number_encrypted" text,
	"order_number_lookup_hash" varchar(128),
	"check_result" "product_check_result" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claimed_products_quantity_chk" CHECK ("claimed_products"."quantity" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "communications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"message_key" varchar(160) NOT NULL,
	"channel" varchar(20) DEFAULT 'email' NOT NULL,
	"recipient_key_version" varchar(40) NOT NULL,
	"recipient_encrypted" text NOT NULL,
	"status" "communication_status" DEFAULT 'queued' NOT NULL,
	"provider_message_id" varchar(160),
	"provider_error_code" varchar(100),
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid,
	"case_id" uuid,
	"category" "evidence_category" NOT NULL,
	"storage_pathname" text NOT NULL,
	"original_file_name" varchar(255) NOT NULL,
	"declared_mime_type" varchar(120) NOT NULL,
	"detected_mime_type" varchar(120),
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64),
	"upload_status" "document_upload_status" DEFAULT 'authorized' NOT NULL,
	"scan_status" "malware_scan_status" DEFAULT 'pending' NOT NULL,
	"uploaded_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_uploads_owner_chk" CHECK ("document_uploads"."draft_id" is not null or "document_uploads"."case_id" is not null),
	CONSTRAINT "document_uploads_size_chk" CHECK ("document_uploads"."size_bytes" > 0),
	CONSTRAINT "document_uploads_sha256_format_chk" CHECK ("document_uploads"."sha256" is null or "document_uploads"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint" varchar(160) NOT NULL,
	"key_hash" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status_code" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"case_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_request_hash_chk" CHECK ("idempotency_records"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "idempotency_records_status_code_chk" CHECK ("idempotency_records"."status_code" between 200 and 599)
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"answer" varchar(16) NOT NULL,
	"event_types" text[] NOT NULL,
	"narrative_key_version" varchar(40) NOT NULL,
	"narrative_encrypted" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"occurred_date_unknown" boolean DEFAULT false NOT NULL,
	"injury_severity" varchar(40),
	"medical_treatment" varchar(40),
	"used_as_intended" varchar(16),
	"company_obtained_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_answer_chk" CHECK ("incidents"."answer" in ('yes', 'unsure')),
	CONSTRAINT "incidents_date_known_chk" CHECK ("incidents"."occurred_at" is not null or "incidents"."occurred_date_unknown" = true),
	CONSTRAINT "incidents_event_types_chk" CHECK (cardinality("incidents"."event_types") > 0)
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" varchar(80) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"deduplication_key" varchar(180) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error_code" varchar(100),
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_attempts_chk" CHECK ("outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recall_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(100) NOT NULL,
	"code" varchar(40) NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"default_locale" varchar(16) DEFAULT 'en-US' NOT NULL,
	"published_version_id" uuid,
	"is_test_data" boolean DEFAULT false NOT NULL,
	"launch_at" timestamp with time zone,
	"close_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recall_campaigns_slug_format_chk" CHECK ("recall_campaigns"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "recall_campaigns_close_after_launch_chk" CHECK ("recall_campaigns"."close_at" is null or "recall_campaigns"."launch_at" is null or "recall_campaigns"."close_at" > "recall_campaigns"."launch_at")
);
--> statement-breakpoint
CREATE TABLE "recall_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_reference" varchar(32) NOT NULL,
	"campaign_id" uuid NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"locale" varchar(16) DEFAULT 'en-US' NOT NULL,
	"subtype" "recall_case_subtype" DEFAULT 'standard' NOT NULL,
	"status" "recall_case_status" DEFAULT 'submitted' NOT NULL,
	"duplicate_flag" boolean DEFAULT false NOT NULL,
	"incident_flag" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recall_cases_public_reference_format_chk" CHECK ("recall_cases"."public_reference" ~ '^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$'),
	CONSTRAINT "recall_cases_incident_subtype_chk" CHECK ("recall_cases"."incident_flag" = false or "recall_cases"."subtype" = 'injury_hazard')
);
--> statement-breakpoint
CREATE TABLE "reportability_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" "reportability_review_status" DEFAULT 'pending' NOT NULL,
	"reviewer_id" uuid,
	"rationale_encrypted" text,
	"decision_at" timestamp with time zone,
	"cpsc_reference" varchar(160),
	"filed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reportability_reviews_decision_chk" CHECK ("reportability_reviews"."status" = 'pending' or ("reportability_reviews"."decision_at" is not null and "reportability_reviews"."rationale_encrypted" is not null)),
	CONSTRAINT "reportability_reviews_filed_chk" CHECK ("reportability_reviews"."status" <> 'filed' or ("reportability_reviews"."cpsc_reference" is not null and "reportability_reviews"."filed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "submission_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"schema_version" varchar(40) NOT NULL,
	"key_version" varchar(40) NOT NULL,
	"encrypted_payload" text NOT NULL,
	"payload_sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_snapshots_sha256_format_chk" CHECK ("submission_snapshots"."payload_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(40) NOT NULL,
	"provider_event_id" varchar(200) NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"status" "webhook_status" DEFAULT 'received' NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error_code" varchar(100)
);
--> statement-breakpoint
ALTER TABLE "campaign_evidence_requirements" ADD CONSTRAINT "campaign_evidence_requirements_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_localizations" ADD CONSTRAINT "campaign_localizations_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_message_templates" ADD CONSTRAINT "campaign_message_templates_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_product_lots" ADD CONSTRAINT "campaign_product_lots_campaign_product_id_campaign_products_id_fk" FOREIGN KEY ("campaign_product_id") REFERENCES "public"."campaign_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_products" ADD CONSTRAINT "campaign_products_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_remedy_options" ADD CONSTRAINT "campaign_remedy_options_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_versions" ADD CONSTRAINT "campaign_versions_campaign_id_recall_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."recall_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_consents" ADD CONSTRAINT "case_consents_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_consumers" ADD CONSTRAINT "case_consumers_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_drafts" ADD CONSTRAINT "claim_drafts_campaign_id_recall_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."recall_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_drafts" ADD CONSTRAINT "claim_drafts_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_drafts" ADD CONSTRAINT "claim_drafts_submitted_case_id_recall_cases_id_fk" FOREIGN KEY ("submitted_case_id") REFERENCES "public"."recall_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claimed_products" ADD CONSTRAINT "claimed_products_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claimed_products" ADD CONSTRAINT "claimed_products_campaign_product_id_campaign_products_id_fk" FOREIGN KEY ("campaign_product_id") REFERENCES "public"."campaign_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_template_id_campaign_message_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."campaign_message_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_uploads" ADD CONSTRAINT "document_uploads_draft_id_claim_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."claim_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_uploads" ADD CONSTRAINT "document_uploads_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_campaigns" ADD CONSTRAINT "recall_campaigns_published_version_id_campaign_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_cases" ADD CONSTRAINT "recall_cases_campaign_id_recall_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."recall_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_cases" ADD CONSTRAINT "recall_cases_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reportability_reviews" ADD CONSTRAINT "reportability_reviews_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_snapshots" ADD CONSTRAINT "submission_snapshots_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_evidence_requirements_version_category_uidx" ON "campaign_evidence_requirements" USING btree ("campaign_version_id","category");--> statement-breakpoint
CREATE INDEX "campaign_localizations_locale_idx" ON "campaign_localizations" USING btree ("locale");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_message_templates_identity_uidx" ON "campaign_message_templates" USING btree ("campaign_version_id","locale","template_type","version");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_product_lots_identity_uidx" ON "campaign_product_lots" USING btree ("campaign_product_id","lot_code","date_code");--> statement-breakpoint
CREATE INDEX "campaign_product_lots_lookup_idx" ON "campaign_product_lots" USING btree ("lot_code","date_code");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_products_version_sku_uidx" ON "campaign_products" USING btree ("campaign_version_id","sku");--> statement-breakpoint
CREATE INDEX "campaign_products_version_sort_idx" ON "campaign_products" USING btree ("campaign_version_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_remedy_options_version_code_uidx" ON "campaign_remedy_options" USING btree ("campaign_version_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_versions_campaign_version_uidx" ON "campaign_versions" USING btree ("campaign_id","version_number");--> statement-breakpoint
CREATE INDEX "campaign_versions_campaign_status_idx" ON "campaign_versions" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "case_consents_identity_uidx" ON "case_consents" USING btree ("case_id","consent_type","text_version");--> statement-breakpoint
CREATE UNIQUE INDEX "case_consumers_case_uidx" ON "case_consumers" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_consumers_email_lookup_idx" ON "case_consumers" USING btree ("email_lookup_hash");--> statement-breakpoint
CREATE INDEX "case_consumers_address_lookup_idx" ON "case_consumers" USING btree ("address_lookup_hash");--> statement-breakpoint
CREATE INDEX "case_events_case_occurred_idx" ON "case_events" USING btree ("case_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_drafts_token_hash_uidx" ON "claim_drafts" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "claim_drafts_expiry_status_idx" ON "claim_drafts" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "claim_drafts_campaign_created_idx" ON "claim_drafts" USING btree ("campaign_id","created_at");--> statement-breakpoint
CREATE INDEX "claimed_products_case_idx" ON "claimed_products" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "claimed_products_lot_date_idx" ON "claimed_products" USING btree ("lot_code","date_code");--> statement-breakpoint
CREATE INDEX "claimed_products_order_lookup_idx" ON "claimed_products" USING btree ("order_number_lookup_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "communications_message_key_uidx" ON "communications" USING btree ("message_key");--> statement-breakpoint
CREATE INDEX "communications_case_status_idx" ON "communications" USING btree ("case_id","status");--> statement-breakpoint
CREATE INDEX "communications_provider_id_idx" ON "communications" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_uploads_storage_pathname_uidx" ON "document_uploads" USING btree ("storage_pathname");--> statement-breakpoint
CREATE INDEX "document_uploads_draft_status_idx" ON "document_uploads" USING btree ("draft_id","upload_status");--> statement-breakpoint
CREATE INDEX "document_uploads_case_category_idx" ON "document_uploads" USING btree ("case_id","category");--> statement-breakpoint
CREATE INDEX "document_uploads_cleanup_idx" ON "document_uploads" USING btree ("upload_status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_records_endpoint_key_uidx" ON "idempotency_records" USING btree ("endpoint","key_hash");--> statement-breakpoint
CREATE INDEX "idempotency_records_expiry_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_case_uidx" ON "incidents" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "incidents_company_obtained_idx" ON "incidents" USING btree ("company_obtained_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_deduplication_key_uidx" ON "outbox_events" USING btree ("deduplication_key");--> statement-breakpoint
CREATE INDEX "outbox_events_dispatch_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recall_campaigns_slug_uidx" ON "recall_campaigns" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "recall_campaigns_code_uidx" ON "recall_campaigns" USING btree ("code");--> statement-breakpoint
CREATE INDEX "recall_campaigns_status_launch_idx" ON "recall_campaigns" USING btree ("status","launch_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recall_cases_public_reference_uidx" ON "recall_cases" USING btree ("public_reference");--> statement-breakpoint
CREATE INDEX "recall_cases_campaign_submitted_idx" ON "recall_cases" USING btree ("campaign_id","submitted_at");--> statement-breakpoint
CREATE INDEX "recall_cases_campaign_status_idx" ON "recall_cases" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reportability_reviews_incident_uidx" ON "reportability_reviews" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "reportability_reviews_pending_idx" ON "reportability_reviews" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_snapshots_case_uidx" ON "submission_snapshots" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uidx" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_received_idx" ON "webhook_events" USING btree ("status","received_at");