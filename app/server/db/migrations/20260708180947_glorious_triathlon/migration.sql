CREATE TYPE "capsule_branch_operation_status" AS ENUM('accepted', 'running', 'completed', 'failed', 'recovering', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_branch_operation_step_status" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "capsule_branch_operation_type" AS ENUM('create');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_cleanup_policy" AS ENUM('delete_on_rollback', 'retain', 'external');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_status" AS ENUM('planned', 'creating', 'created', 'deleting', 'deleted', 'adopted', 'missing', 'orphaned', 'error');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_type" AS ENUM('incus_project', 'incus_instance', 'zfs_volume', 'bind_mount', 'provisioning_file');--> statement-breakpoint
CREATE TYPE "capsule_branch_status" AS ENUM('provisioning', 'recovering', 'offline', 'starting', 'online', 'stopping', 'archived', 'error', 'cleanup_required');--> statement-breakpoint
CREATE TABLE "capsule_branch_operation_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"operation_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"branch_id" uuid,
	"branch_name" text NOT NULL,
	"step_key" text NOT NULL,
	"status" "capsule_branch_operation_step_status" DEFAULT 'pending'::"capsule_branch_operation_step_status" NOT NULL,
	"metadata" jsonb,
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
CREATE TABLE "capsule_branch_operations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"branch_id" uuid,
	"type" "capsule_branch_operation_type" NOT NULL,
	"status" "capsule_branch_operation_status" DEFAULT 'accepted'::"capsule_branch_operation_status" NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"branch_name" text NOT NULL,
	"blueprint_name" text NOT NULL,
	"blueprint_digest" text NOT NULL,
	"blueprint_snapshot" jsonb NOT NULL,
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
CREATE TABLE "capsule_branch_resources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"branch_id" uuid,
	"branch_name" text NOT NULL,
	"created_by_operation_id" uuid,
	"last_operation_id" uuid,
	"resource_type" "capsule_branch_resource_type" NOT NULL,
	"provider" text DEFAULT 'incus' NOT NULL,
	"resource_key" text NOT NULL,
	"status" "capsule_branch_resource_status" DEFAULT 'planned'::"capsule_branch_resource_status" NOT NULL,
	"cleanup_policy" "capsule_branch_resource_cleanup_policy" NOT NULL,
	"metadata" jsonb,
	"failure_code" text,
	"failure_message" text,
	"failure_details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE INDEX "capsule_branch_operation_steps_operation_idx" ON "capsule_branch_operation_steps" ("operation_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_operation_steps_owner_status_idx" ON "capsule_branch_operation_steps" ("owner_id","status");--> statement-breakpoint
CREATE INDEX "capsule_branch_operation_steps_branch_idx" ON "capsule_branch_operation_steps" ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branch_operation_steps_operation_key_unique_idx" ON "capsule_branch_operation_steps" ("operation_id","step_key");--> statement-breakpoint
CREATE INDEX "capsule_branch_operations_owner_status_idx" ON "capsule_branch_operations" ("owner_id","status");--> statement-breakpoint
CREATE INDEX "capsule_branch_operations_owner_branch_idx" ON "capsule_branch_operations" ("owner_id","branch_name");--> statement-breakpoint
CREATE INDEX "capsule_branch_operations_branch_idx" ON "capsule_branch_operations" ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branch_operations_owner_idempotency_key_unique_idx" ON "capsule_branch_operations" ("owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_owner_idx" ON "capsule_branch_resources" ("owner_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_branch_idx" ON "capsule_branch_resources" ("branch_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_created_by_operation_idx" ON "capsule_branch_resources" ("created_by_operation_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_last_operation_idx" ON "capsule_branch_resources" ("last_operation_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_resource_key_idx" ON "capsule_branch_resources" ("resource_key");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branch_resources_operation_key_unique_idx" ON "capsule_branch_resources" ("created_by_operation_id","resource_key");--> statement-breakpoint
CREATE INDEX "capsule_branches_owner_idx" ON "capsule_branches" ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branches_owner_name_unique_idx" ON "capsule_branches" ("owner_id","name");--> statement-breakpoint
ALTER TABLE "capsule_branch_operation_steps" ADD CONSTRAINT "capsule_branch_operation_steps_uNAmnvHp3YGG_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_branch_operations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_branch_operation_steps" ADD CONSTRAINT "capsule_branch_operation_steps_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_branch_operation_steps" ADD CONSTRAINT "capsule_branch_operation_steps_p1Yz7KcKGYiI_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_branch_operations" ADD CONSTRAINT "capsule_branch_operations_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_branch_operations" ADD CONSTRAINT "capsule_branch_operations_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_tXBWLFwNvFdR_fkey" FOREIGN KEY ("created_by_operation_id") REFERENCES "capsule_branch_operations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_DsYJtaQyabhr_fkey" FOREIGN KEY ("last_operation_id") REFERENCES "capsule_branch_operations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_branches" ADD CONSTRAINT "capsule_branches_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;