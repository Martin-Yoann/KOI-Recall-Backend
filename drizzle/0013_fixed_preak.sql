ALTER TABLE "staff_users" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
UPDATE "staff_users"
SET "role" = CASE
  WHEN "role" = 'administrator' THEN 'ADMIN'
  WHEN "role" IN ('viewer', 'reviewer', 'compliance') THEN 'MANAGER'
  ELSE 'MANAGER'
END;--> statement-breakpoint
UPDATE "admin_audit_events"
SET "actor_role" = CASE
  WHEN "actor_role" = 'administrator' THEN 'ADMIN'
  WHEN "actor_role" IN ('viewer', 'reviewer', 'compliance') THEN 'MANAGER'
  ELSE "actor_role"
END
WHERE "actor_role" IS NOT NULL;--> statement-breakpoint
DROP TYPE "public"."staff_role";--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('ADMIN', 'MANAGER');--> statement-breakpoint
ALTER TABLE "staff_users" ALTER COLUMN "role" SET DATA TYPE "public"."staff_role" USING "role"::"public"."staff_role";