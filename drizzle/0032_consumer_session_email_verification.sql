CREATE TABLE "consumer_email_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consumer_sessions" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consumer_email_verifications" ADD CONSTRAINT "consumer_email_verifications_user_id_consumer_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."consumer_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumer_email_verifications" ADD CONSTRAINT "consumer_email_verifications_session_id_consumer_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."consumer_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consumer_email_verifications_token_uidx" ON "consumer_email_verifications" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "consumer_email_verifications_user_created_idx" ON "consumer_email_verifications" USING btree ("user_id","created_at");