CREATE TYPE "capsule_branch_status" AS ENUM('provisioning', 'offline', 'starting', 'online', 'stopping', 'archived', 'error');--> statement-breakpoint
CREATE TABLE "capsule_branches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"runtime_ip" text,
	"name" text NOT NULL,
	"cpu" text DEFAULT '4' NOT NULL,
	"memory" text DEFAULT '4GB' NOT NULL,
	"blueprint_name" text DEFAULT 'n8n-comfyui-capsule' NOT NULL,
	"status" "capsule_branch_status" DEFAULT 'provisioning'::"capsule_branch_status" NOT NULL,
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
CREATE INDEX "capsule_branches_owner_idx" ON "capsule_branches" ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branches_owner_name_unique_idx" ON "capsule_branches" ("owner_id","name");--> statement-breakpoint
ALTER TABLE "capsule_branches" ADD CONSTRAINT "capsule_branches_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;