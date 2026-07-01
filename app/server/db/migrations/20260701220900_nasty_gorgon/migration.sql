CREATE TYPE "instance_status" AS ENUM('provisioning', 'offline', 'starting', 'online', 'stopping', 'archived', 'error');--> statement-breakpoint
CREATE TABLE "instances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"ip" text,
	"name" text NOT NULL,
	"cpu" text DEFAULT '4' NOT NULL,
	"memory" text DEFAULT '4GB' NOT NULL,
	"definition" text DEFAULT 'n8n-comfyui-capsule' NOT NULL,
	"status" "instance_status" DEFAULT 'provisioning'::"instance_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"username" text NOT NULL UNIQUE,
	"email" text NOT NULL UNIQUE,
	"password" text NOT NULL,
	"avatar" text DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "instances_owner_idx" ON "instances" ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instances_owner_name_unique_idx" ON "instances" ("owner_id","name");--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;