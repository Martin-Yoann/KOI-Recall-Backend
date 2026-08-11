CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'denied', 'error');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('viewer', 'reviewer', 'compliance', 'administrator');--> statement-breakpoint
CREATE TYPE "public"."staff_session_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."staff_user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_role" varchar(24),
	"action" varchar(80) NOT NULL,
	"resource_type" varchar(40),
	"resource_id" varchar(160),
	"outcome" "audit_outcome" NOT NULL,
	"reason_code" varchar(80),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address_hash" varchar(128),
	"user_agent_hash" varchar(128),
	CONSTRAINT "admin_audit_events_action_nonempty_chk" CHECK (char_length("admin_audit_events"."action") > 0)
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"status" "staff_session_status" DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"issued_ip_hash" varchar(128),
	"issued_user_agent_hash" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_lookup_hash" varchar(128) NOT NULL,
	"email" text NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"role" "staff_role" NOT NULL,
	"status" "staff_user_status" DEFAULT 'active' NOT NULL,
	"password_hash" text,
	"password_changed_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recall_cases" ADD COLUMN "assigned_to_staff_user_id" uuid;--> statement-breakpoint
ALTER TABLE "recall_cases" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_actor_user_id_staff_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_user_id_staff_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_events_actor_occurred_idx" ON "admin_audit_events" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "admin_audit_events_resource_idx" ON "admin_audit_events" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "admin_audit_events_action_occurred_idx" ON "admin_audit_events" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_sessions_token_hash_uidx" ON "staff_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "staff_sessions_user_status_idx" ON "staff_sessions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_users_email_lookup_hash_uidx" ON "staff_users" USING btree ("email_lookup_hash");--> statement-breakpoint
ALTER TABLE "recall_cases" ADD CONSTRAINT "recall_cases_assigned_to_staff_user_id_staff_users_id_fk" FOREIGN KEY ("assigned_to_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recall_cases_assignee_idx" ON "recall_cases" USING btree ("assigned_to_staff_user_id","status");