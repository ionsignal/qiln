CREATE TYPE "capsule_branch_status" AS ENUM('provisioning', 'recovering', 'offline', 'starting', 'online', 'stopping', 'archived', 'error', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_operation_cleanup_policy" AS ENUM('delete_on_rollback', 'retain', 'external');--> statement-breakpoint
CREATE TYPE "capsule_operation_resource_status" AS ENUM('planned', 'creating', 'created', 'deleting', 'deleted', 'adopted', 'missing', 'orphaned', 'error');--> statement-breakpoint
CREATE TYPE "capsule_operation_resource_type" AS ENUM('incus_project', 'incus_instance', 'zfs_volume', 'bind_mount', 'provisioning_file');--> statement-breakpoint
CREATE TYPE "capsule_operation_status" AS ENUM('accepted', 'running', 'completed', 'failed', 'recovering', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_operation_type" AS ENUM('branch_create');--> statement-breakpoint
CREATE TABLE "capsule_branches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"runtime_ip" text,
	"name" text NOT NULL,
	"cpu" text DEFAULT '4' NOT NULL,
	"memory" text DEFAULT '4GB' NOT NULL,
	"blueprint_name" text DEFAULT 'n8n-comfyui-capsule' NOT NULL,
	"blueprint_digest" text NOT NULL,
	"status" "capsule_branch_status" DEFAULT 'provisioning'::"capsule_branch_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capsule_operation_resources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"operation_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"branch_id" uuid,
	"branch_name" text NOT NULL,
	"resource_type" "capsule_operation_resource_type" NOT NULL,
	"provider" text DEFAULT 'incus' NOT NULL,
	"resource_key" text NOT NULL,
	"status" "capsule_operation_resource_status" DEFAULT 'planned'::"capsule_operation_resource_status" NOT NULL,
	"cleanup_policy" "capsule_operation_cleanup_policy" NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capsule_operations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"type" "capsule_operation_type" NOT NULL,
	"status" "capsule_operation_status" DEFAULT 'accepted'::"capsule_operation_status" NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"branch_id" uuid,
	"branch_name" text NOT NULL,
	"blueprint_name" text NOT NULL,
	"blueprint_digest" text NOT NULL,
	"blueprint_snapshot" jsonb NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"failure_details" jsonb,
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
CREATE INDEX "capsule_operation_resources_operation_idx" ON "capsule_operation_resources" ("operation_id");--> statement-breakpoint
CREATE INDEX "capsule_operation_resources_owner_idx" ON "capsule_operation_resources" ("owner_id");--> statement-breakpoint
CREATE INDEX "capsule_operation_resources_branch_idx" ON "capsule_operation_resources" ("branch_id");--> statement-breakpoint
CREATE INDEX "capsule_operation_resources_resource_key_idx" ON "capsule_operation_resources" ("resource_key");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_operation_resources_operation_key_unique_idx" ON "capsule_operation_resources" ("operation_id","resource_key");--> statement-breakpoint
CREATE INDEX "capsule_operations_owner_status_idx" ON "capsule_operations" ("owner_id","status");--> statement-breakpoint
CREATE INDEX "capsule_operations_branch_idx" ON "capsule_operations" ("branch_id");--> statement-breakpoint
CREATE INDEX "capsule_operations_lease_idx" ON "capsule_operations" ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_operations_owner_idempotency_key_unique_idx" ON "capsule_operations" ("owner_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "capsule_branches" ADD CONSTRAINT "capsule_branches_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operation_resources" ADD CONSTRAINT "capsule_operation_resources_mqBlMLgaXUvi_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_operations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operation_resources" ADD CONSTRAINT "capsule_operation_resources_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operation_resources" ADD CONSTRAINT "capsule_operation_resources_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_operations" ADD CONSTRAINT "capsule_operations_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operations" ADD CONSTRAINT "capsule_operations_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;