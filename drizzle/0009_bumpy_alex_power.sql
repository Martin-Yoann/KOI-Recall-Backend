CREATE TYPE "public"."consumer_session_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."consumer_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "consumer_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"status" "consumer_session_status" DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consumer_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_lookup_hash" varchar(128) NOT NULL,
	"email" text NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"avatar_data_url" text,
	"password_hash" text NOT NULL,
	"status" "consumer_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consumer_sessions" ADD CONSTRAINT "consumer_sessions_user_id_consumer_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."consumer_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consumer_sessions_token_hash_uidx" ON "consumer_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "consumer_sessions_user_status_idx" ON "consumer_sessions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "consumer_users_email_lookup_hash_uidx" ON "consumer_users" USING btree ("email_lookup_hash");