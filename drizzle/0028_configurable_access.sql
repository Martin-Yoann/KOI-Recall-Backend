CREATE TABLE "staff_access_policy" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"policy" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_access_policy_singleton_chk" CHECK ("staff_access_policy"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "is_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_users_single_owner_uidx" ON "staff_users" USING btree ("is_owner") WHERE "staff_users"."is_owner" = true;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_owner_identity_chk" CHECK (NOT "staff_users"."is_owner" OR (lower(trim("staff_users"."email")) = 'admin@koi-platform.com' AND "staff_users"."status" = 'active' AND "staff_users"."role" = 'ADMIN'));
--> statement-breakpoint
UPDATE staff_users SET is_owner = true, role = 'ADMIN', status = 'active'
WHERE lower(trim(email)) = 'admin@koi-platform.com';
--> statement-breakpoint
CREATE FUNCTION protect_staff_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_owner THEN RAISE EXCEPTION 'The Owner account cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_owner THEN
    IF NOT NEW.is_owner OR NEW.email IS DISTINCT FROM OLD.email OR NEW.role <> 'ADMIN' OR NEW.status <> 'active' THEN
      RAISE EXCEPTION 'The Owner identity, role and active status cannot be changed';
    END IF;
  END IF;
  IF lower(trim(NEW.email)) = 'admin@koi-platform.com' AND NOT NEW.is_owner THEN
    RAISE EXCEPTION 'The reserved Owner account must be provisioned as Owner';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER staff_owner_protection BEFORE INSERT OR UPDATE OR DELETE ON staff_users
FOR EACH ROW EXECUTE FUNCTION protect_staff_owner();
