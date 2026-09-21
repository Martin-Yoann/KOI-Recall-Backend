CREATE TYPE "public"."disposal_approval_material" AS ENUM('recall_expectation_letter', 'cap_or_written_coordination', 'nov', 'laboratory_report', 'form_332_inventory_procedure', 'cbp_seizure_record', 'other');--> statement-breakpoint
CREATE TYPE "public"."disposal_approval_scope" AS ENUM('consumer_held_product', 'enterprise_inventory', 'port_involved_goods', 'not_determined');--> statement-breakpoint
CREATE TYPE "public"."disposal_authorization_status" AS ENUM('active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."disposal_batch_review_status" AS ENUM('pending', 'accepted', 'needs_resubmission', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."disposal_declaration_exception" AS ENUM('already_disposed_before_authorization', 'evidence_unavailable', 'other');--> statement-breakpoint
CREATE TYPE "public"."disposal_eligibility_status" AS ENUM('pending_confirmation', 'confirmed_eligible', 'not_applicable', 'ineligible');--> statement-breakpoint
CREATE TYPE "public"."disposal_hold_reason" AS ENUM('incident_evidence_retention', 'compliance_investigation', 'other');--> statement-breakpoint
CREATE TYPE "public"."disposal_instruction_status" AS ENUM('draft', 'approved', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."disposal_measure" AS ENUM('consumer_disposal', 'consumer_return', 'professional_recycling', 'other_compensation', 'not_determined');--> statement-breakpoint
CREATE TYPE "public"."disposal_review_decision" AS ENUM('accepted', 'needs_resubmission');--> statement-breakpoint
CREATE TYPE "public"."disposal_task_status" AS ENUM('open', 'completed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "disposal_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"instruction_version_id" uuid NOT NULL,
	"status" "disposal_authorization_status" DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_staff_user_id" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposal_authorizations_revoked_chk" CHECK ("disposal_authorizations"."status" <> 'revoked' or ("disposal_authorizations"."revoked_at" is not null and "disposal_authorizations"."revoke_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "disposal_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"authorization_id" uuid,
	"exception_type" "disposal_declaration_exception",
	"exception_note" text,
	"declaration_text_version" varchar(80) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposal_declarations_basis_chk" CHECK (("disposal_declarations"."authorization_id" is not null) <> ("disposal_declarations"."exception_type" is not null)),
	CONSTRAINT "disposal_declarations_exception_note_chk" CHECK ("disposal_declarations"."exception_type" is null or "disposal_declarations"."exception_note" is not null)
);
--> statement-breakpoint
CREATE TABLE "disposal_evidence_batch_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"campaign_product_id" uuid,
	"quantity_covered" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposal_evidence_batch_documents_quantity_chk" CHECK ("disposal_evidence_batch_documents"."quantity_covered" is null or "disposal_evidence_batch_documents"."quantity_covered" > 0)
);
--> statement-breakpoint
CREATE TABLE "disposal_evidence_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"batch_number" integer NOT NULL,
	"review_status" "disposal_batch_review_status" DEFAULT 'pending' NOT NULL,
	"retention_until" timestamp with time zone,
	"idempotency_key_hash" varchar(64) NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposal_evidence_batches_number_chk" CHECK ("disposal_evidence_batches"."batch_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "disposal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"reason" "disposal_hold_reason" NOT NULL,
	"note" text,
	"placed_by_staff_user_id" uuid,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by_staff_user_id" uuid,
	"released_at" timestamp with time zone,
	"release_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposal_holds_release_chk" CHECK ("disposal_holds"."released_at" is null or "disposal_holds"."released_by_staff_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "disposal_instruction_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instruction_version_id" uuid NOT NULL,
	"material_type" "disposal_approval_material" NOT NULL,
	"scope" "disposal_approval_scope" NOT NULL,
	"measure" "disposal_measure" NOT NULL,
	"authorizes_consumer_disposal" boolean NOT NULL,
	"reference_text" varchar(200),
	"effective_from" timestamp with time zone,
	"effective_until" timestamp with time zone,
	"recorded_by_staff_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposal_instruction_approvals_authorizing_chk" CHECK ("disposal_instruction_approvals"."authorizes_consumer_disposal" = (
            "disposal_instruction_approvals"."measure" = 'consumer_disposal'
            and "disposal_instruction_approvals"."scope" = 'consumer_held_product'
            and "disposal_instruction_approvals"."material_type" in ('recall_expectation_letter', 'cap_or_written_coordination')
          )),
	CONSTRAINT "disposal_instruction_approvals_effective_chk" CHECK ("disposal_instruction_approvals"."effective_until" is null or "disposal_instruction_approvals"."effective_from" is null or "disposal_instruction_approvals"."effective_until" > "disposal_instruction_approvals"."effective_from"),
	CONSTRAINT "disposal_instruction_approvals_withdrawn_chk" CHECK ("disposal_instruction_approvals"."withdrawn_at" is null or "disposal_instruction_approvals"."withdrawal_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "disposal_instruction_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"locale" varchar(16) NOT NULL,
	"status" "disposal_instruction_status" DEFAULT 'draft' NOT NULL,
	"title" varchar(240) NOT NULL,
	"steps" jsonb NOT NULL,
	"reference_images" jsonb NOT NULL,
	"video_url" text,
	"safety_warnings" jsonb NOT NULL,
	"recognition_requirements" jsonb NOT NULL,
	"declaration_text_version" varchar(80) NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by_staff_user_id" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_staff_user_id" uuid,
	"withdrawal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposal_instruction_versions_number_chk" CHECK ("disposal_instruction_versions"."version_number" > 0),
	CONSTRAINT "disposal_instruction_versions_steps_chk" CHECK (jsonb_array_length("disposal_instruction_versions"."steps") > 0),
	CONSTRAINT "disposal_instruction_versions_warnings_chk" CHECK (jsonb_array_length("disposal_instruction_versions"."safety_warnings") > 0),
	CONSTRAINT "disposal_instruction_versions_approved_chk" CHECK ("disposal_instruction_versions"."status" <> 'approved' or ("disposal_instruction_versions"."approved_at" is not null and "disposal_instruction_versions"."approved_by_staff_user_id" is not null)),
	CONSTRAINT "disposal_instruction_versions_withdrawn_chk" CHECK (("disposal_instruction_versions"."status" = 'withdrawn') = ("disposal_instruction_versions"."withdrawn_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "disposal_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"decision" "disposal_review_decision" NOT NULL,
	"reason_code" varchar(40),
	"rationale" text NOT NULL,
	"reviewer_staff_user_id" uuid,
	"reviewer_role" varchar(24),
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposal_reviews_rationale_chk" CHECK (length("disposal_reviews"."rationale") >= 10)
);
--> statement-breakpoint
CREATE TABLE "disposal_task_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"campaign_product_id" uuid NOT NULL,
	"lot_code" varchar(80),
	"date_code" varchar(40),
	"quantity" integer DEFAULT 1 NOT NULL,
	"confirmed_affected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposal_task_products_quantity_chk" CHECK ("disposal_task_products"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "disposal_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instruction_version_id" uuid NOT NULL,
	"draft_id" uuid,
	"case_id" uuid,
	"token_hash" varchar(64) NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"eligibility_status" "disposal_eligibility_status" DEFAULT 'pending_confirmation' NOT NULL,
	"eligibility_confirmed_by_staff_user_id" uuid,
	"eligibility_confirmed_at" timestamp with time zone,
	"eligibility_note" text,
	"status" "disposal_task_status" DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposal_tasks_owner_chk" CHECK ("disposal_tasks"."draft_id" is not null or "disposal_tasks"."case_id" is not null),
	CONSTRAINT "disposal_tasks_eligibility_confirmed_chk" CHECK ("disposal_tasks"."eligibility_status" <> 'confirmed_eligible' or ("disposal_tasks"."eligibility_confirmed_at" is not null and "disposal_tasks"."eligibility_confirmed_by_staff_user_id" is not null)),
	CONSTRAINT "disposal_tasks_eligibility_decided_chk" CHECK ("disposal_tasks"."eligibility_status" = 'pending_confirmation' or ("disposal_tasks"."eligibility_confirmed_at" is not null and "disposal_tasks"."eligibility_confirmed_by_staff_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "disposal_authorizations" ADD CONSTRAINT "disposal_authorizations_task_id_disposal_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."disposal_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_authorizations" ADD CONSTRAINT "disposal_authorizations_batch_id_disposal_evidence_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."disposal_evidence_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_authorizations" ADD CONSTRAINT "disposal_authorizations_instruction_version_id_disposal_instruction_versions_id_fk" FOREIGN KEY ("instruction_version_id") REFERENCES "public"."disposal_instruction_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_authorizations" ADD CONSTRAINT "disposal_authorizations_revoked_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("revoked_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_declarations" ADD CONSTRAINT "disposal_declarations_task_id_disposal_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."disposal_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_declarations" ADD CONSTRAINT "disposal_declarations_authorization_id_disposal_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."disposal_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_evidence_batch_documents" ADD CONSTRAINT "disposal_evidence_batch_documents_batch_id_disposal_evidence_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."disposal_evidence_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_evidence_batch_documents" ADD CONSTRAINT "disposal_evidence_batch_documents_document_id_document_uploads_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_evidence_batch_documents" ADD CONSTRAINT "disposal_evidence_batch_documents_campaign_product_id_campaign_products_id_fk" FOREIGN KEY ("campaign_product_id") REFERENCES "public"."campaign_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_evidence_batches" ADD CONSTRAINT "disposal_evidence_batches_task_id_disposal_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."disposal_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_holds" ADD CONSTRAINT "disposal_holds_task_id_disposal_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."disposal_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_holds" ADD CONSTRAINT "disposal_holds_placed_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("placed_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_holds" ADD CONSTRAINT "disposal_holds_released_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("released_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_instruction_approvals" ADD CONSTRAINT "disposal_instruction_approvals_instruction_version_id_disposal_instruction_versions_id_fk" FOREIGN KEY ("instruction_version_id") REFERENCES "public"."disposal_instruction_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_instruction_approvals" ADD CONSTRAINT "disposal_instruction_approvals_recorded_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("recorded_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_instruction_versions" ADD CONSTRAINT "disposal_instruction_versions_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_instruction_versions" ADD CONSTRAINT "disposal_instruction_versions_approved_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("approved_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_instruction_versions" ADD CONSTRAINT "disposal_instruction_versions_withdrawn_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("withdrawn_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_reviews" ADD CONSTRAINT "disposal_reviews_batch_id_disposal_evidence_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."disposal_evidence_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_reviews" ADD CONSTRAINT "disposal_reviews_reviewer_staff_user_id_staff_users_id_fk" FOREIGN KEY ("reviewer_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_task_products" ADD CONSTRAINT "disposal_task_products_task_id_disposal_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."disposal_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_task_products" ADD CONSTRAINT "disposal_task_products_campaign_product_id_campaign_products_id_fk" FOREIGN KEY ("campaign_product_id") REFERENCES "public"."campaign_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_tasks" ADD CONSTRAINT "disposal_tasks_instruction_version_id_disposal_instruction_versions_id_fk" FOREIGN KEY ("instruction_version_id") REFERENCES "public"."disposal_instruction_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_tasks" ADD CONSTRAINT "disposal_tasks_draft_id_claim_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."claim_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_tasks" ADD CONSTRAINT "disposal_tasks_case_id_recall_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recall_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_tasks" ADD CONSTRAINT "disposal_tasks_eligibility_confirmed_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("eligibility_confirmed_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disposal_authorizations_task_idx" ON "disposal_authorizations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "disposal_authorizations_version_idx" ON "disposal_authorizations" USING btree ("instruction_version_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "disposal_authorizations_active_uidx" ON "disposal_authorizations" USING btree ("task_id","batch_id") WHERE "disposal_authorizations"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "disposal_declarations_authorization_uidx" ON "disposal_declarations" USING btree ("authorization_id");--> statement-breakpoint
CREATE INDEX "disposal_declarations_task_idx" ON "disposal_declarations" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disposal_evidence_batch_documents_document_uidx" ON "disposal_evidence_batch_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "disposal_evidence_batch_documents_batch_idx" ON "disposal_evidence_batch_documents" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disposal_evidence_batches_number_uidx" ON "disposal_evidence_batches" USING btree ("task_id","batch_number");--> statement-breakpoint
CREATE UNIQUE INDEX "disposal_evidence_batches_idempotency_uidx" ON "disposal_evidence_batches" USING btree ("idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "disposal_evidence_batches_status_idx" ON "disposal_evidence_batches" USING btree ("review_status","submitted_at");--> statement-breakpoint
CREATE INDEX "disposal_holds_task_idx" ON "disposal_holds" USING btree ("task_id","released_at");--> statement-breakpoint
CREATE INDEX "disposal_instruction_approvals_version_idx" ON "disposal_instruction_approvals" USING btree ("instruction_version_id","authorizes_consumer_disposal");--> statement-breakpoint
CREATE UNIQUE INDEX "disposal_instruction_versions_identity_uidx" ON "disposal_instruction_versions" USING btree ("campaign_version_id","locale","version_number");--> statement-breakpoint
CREATE INDEX "disposal_instruction_versions_status_idx" ON "disposal_instruction_versions" USING btree ("campaign_version_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "disposal_reviews_batch_uidx" ON "disposal_reviews" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disposal_task_products_identity_uidx" ON "disposal_task_products" USING btree ("task_id","campaign_product_id",coalesce("lot_code", ''),coalesce("date_code", ''));--> statement-breakpoint
CREATE INDEX "disposal_tasks_draft_idx" ON "disposal_tasks" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "disposal_tasks_case_idx" ON "disposal_tasks" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "disposal_tasks_token_idx" ON "disposal_tasks" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "disposal_tasks_open_uidx" ON "disposal_tasks" USING btree ("draft_id","instruction_version_id") WHERE "disposal_tasks"."status" = 'open';