CREATE TYPE "capsule_actor_type" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_cleanup_policy" AS ENUM('delete_with_branch', 'retain', 'external');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_status" AS ENUM('planned', 'creating', 'created', 'deleting', 'deleted', 'adopted', 'missing', 'error');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_type" AS ENUM('incus_project', 'incus_instance', 'zfs_volume', 'bind_mount', 'provisioning_file');--> statement-breakpoint
CREATE TYPE "capsule_branch_status" AS ENUM('provisioning', 'offline', 'starting', 'online', 'stopping', 'destroying', 'destroyed', 'error', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_lifecycle_status" AS ENUM('provisioning', 'active', 'archiving', 'unarchiving', 'destroying', 'destroyed', 'creation_failed', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_operation_status" AS ENUM('accepted', 'running', 'completed', 'failed', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_operation_step_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "capsule_operation_type" AS ENUM('create', 'archive', 'unarchive', 'destroy');--> statement-breakpoint
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
	"capsule_id" uuid NOT NULL,
	"runtime_ip" text,
	"runtime_error_code" text,
	"runtime_error_message" text,
	"runtime_error_details" jsonb,
	"runtime_error_at" timestamp with time zone,
	"name" text NOT NULL,
	"cpu" text DEFAULT '4' NOT NULL,
	"memory" text DEFAULT '4GB' NOT NULL,
	"blueprint_name" text DEFAULT 'n8n-comfyui-capsule' NOT NULL,
	"blueprint_digest" text NOT NULL,
	"resource_inventory_digest" text,
	"status" "capsule_branch_status" DEFAULT 'provisioning'::"capsule_branch_status" NOT NULL,
	"is_root_branch" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capsule_branches_runtime_error_details_check" CHECK ((
          "status" <> 'error'
          OR (
            "runtime_error_code" IS NOT NULL
            AND "runtime_error_message" IS NOT NULL
            AND "runtime_error_details" IS NOT NULL
            AND "runtime_error_at" IS NOT NULL
          )
        )),
	CONSTRAINT "capsule_branches_offline_runtime_ip_check" CHECK ((
          "status" <> 'offline'
          OR "runtime_ip" IS NULL
        ))
);
--> statement-breakpoint
CREATE TABLE "capsule_create_operations" (
	"operation_id" uuid PRIMARY KEY,
	"root_branch_id" uuid NOT NULL,
	"root_branch_name" text NOT NULL,
	"blueprint_name" text NOT NULL,
	"blueprint_digest" text NOT NULL,
	"blueprint_snapshot" jsonb NOT NULL,
	"cpu" text NOT NULL,
	"memory" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capsule_operation_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"operation_id" uuid NOT NULL,
	"capsule_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"branch_id" uuid,
	"branch_name" text,
	"step_key" text NOT NULL,
	"status" "capsule_operation_step_status" DEFAULT 'pending'::"capsule_operation_step_status" NOT NULL,
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
CREATE TABLE "capsule_operations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"actor_type" "capsule_actor_type" NOT NULL,
	"actor_id" uuid NOT NULL,
	"capsule_id" uuid NOT NULL,
	"type" "capsule_operation_type" NOT NULL,
	"status" "capsule_operation_status" DEFAULT 'accepted'::"capsule_operation_status" NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"execution_started_at" timestamp with time zone,
	"provider_mutation_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"failure_details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capsule_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"capsule_id" uuid NOT NULL,
	"source_branch_id" uuid NOT NULL,
	"artifact_manifest_schema_version" integer NOT NULL,
	"artifact_manifest_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "capsules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"lifecycle_status" "capsule_lifecycle_status" DEFAULT 'provisioning'::"capsule_lifecycle_status" NOT NULL,
	"archived_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capsules_destroyed_timestamp_check" CHECK ((
          ("lifecycle_status" = 'destroyed' AND "destroyed_at" IS NOT NULL)
          OR
          ("lifecycle_status" <> 'destroyed' AND "destroyed_at" IS NULL)
        )),
	CONSTRAINT "capsules_destroy_requires_archive_check" CHECK ((
          "lifecycle_status" NOT IN ('destroying', 'destroyed')
          OR
          "archived_at" IS NOT NULL
        ))
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
CREATE INDEX "capsule_branch_resources_owner_idx" ON "capsule_branch_resources" ("owner_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_branch_idx" ON "capsule_branch_resources" ("branch_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_created_by_operation_idx" ON "capsule_branch_resources" ("created_by_operation_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_last_operation_idx" ON "capsule_branch_resources" ("last_operation_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_resource_key_idx" ON "capsule_branch_resources" ("resource_key");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branch_resources_operation_key_unique_idx" ON "capsule_branch_resources" ("created_by_operation_id","resource_key");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branch_resources_branch_key_unique_idx" ON "capsule_branch_resources" ("branch_id","resource_key");--> statement-breakpoint
CREATE INDEX "capsule_branches_owner_idx" ON "capsule_branches" ("owner_id");--> statement-breakpoint
CREATE INDEX "capsule_branches_capsule_idx" ON "capsule_branches" ("capsule_id");--> statement-breakpoint
CREATE INDEX "capsule_branches_runtime_status_idx" ON "capsule_branches" ("status");--> statement-breakpoint
CREATE INDEX "capsule_branches_owner_runtime_status_idx" ON "capsule_branches" ("owner_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branches_owner_runtime_name_unique_idx" ON "capsule_branches" ("owner_id","name") WHERE "status" <> 'destroyed';--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branches_capsule_root_unique_idx" ON "capsule_branches" ("capsule_id") WHERE "is_root_branch" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_create_operations_root_branch_unique_idx" ON "capsule_create_operations" ("root_branch_id");--> statement-breakpoint
CREATE INDEX "capsule_operation_steps_operation_idx" ON "capsule_operation_steps" ("operation_id");--> statement-breakpoint
CREATE INDEX "capsule_operation_steps_capsule_idx" ON "capsule_operation_steps" ("capsule_id");--> statement-breakpoint
CREATE INDEX "capsule_operation_steps_owner_status_idx" ON "capsule_operation_steps" ("owner_id","status");--> statement-breakpoint
CREATE INDEX "capsule_operation_steps_branch_idx" ON "capsule_operation_steps" ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_operation_steps_operation_key_unique_idx" ON "capsule_operation_steps" ("operation_id","step_key");--> statement-breakpoint
CREATE INDEX "capsule_operations_owner_status_idx" ON "capsule_operations" ("owner_id","status");--> statement-breakpoint
CREATE INDEX "capsule_operations_actor_idx" ON "capsule_operations" ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "capsule_operations_capsule_status_idx" ON "capsule_operations" ("capsule_id","status");--> statement-breakpoint
CREATE INDEX "capsule_operations_provider_mutation_started_idx" ON "capsule_operations" ("provider_mutation_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_operations_owner_idempotency_key_unique_idx" ON "capsule_operations" ("owner_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_operations_capsule_nonterminal_unique_idx" ON "capsule_operations" ("capsule_id") WHERE "status" IN ('accepted', 'running');--> statement-breakpoint
CREATE INDEX "capsule_snapshots_capsule_created_idx" ON "capsule_snapshots" ("capsule_id","created_at");--> statement-breakpoint
CREATE INDEX "capsule_snapshots_source_branch_idx" ON "capsule_snapshots" ("source_branch_id");--> statement-breakpoint
CREATE INDEX "capsules_owner_idx" ON "capsules" ("owner_id");--> statement-breakpoint
CREATE INDEX "capsules_owner_lifecycle_status_idx" ON "capsules" ("owner_id","lifecycle_status");--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_3Q5TCQ46rOSG_fkey" FOREIGN KEY ("created_by_operation_id") REFERENCES "capsule_operations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_ltnZH1shcsde_fkey" FOREIGN KEY ("last_operation_id") REFERENCES "capsule_operations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_branches" ADD CONSTRAINT "capsule_branches_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_branches" ADD CONSTRAINT "capsule_branches_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_create_operations" ADD CONSTRAINT "capsule_create_operations_kBDKOqhsMbzu_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_operations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_create_operations" ADD CONSTRAINT "capsule_create_operations_GXQTF2XIoGx4_fkey" FOREIGN KEY ("root_branch_id") REFERENCES "capsule_branches"("id");--> statement-breakpoint
ALTER TABLE "capsule_operation_steps" ADD CONSTRAINT "capsule_operation_steps_operation_id_capsule_operations_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_operations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operation_steps" ADD CONSTRAINT "capsule_operation_steps_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operation_steps" ADD CONSTRAINT "capsule_operation_steps_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operation_steps" ADD CONSTRAINT "capsule_operation_steps_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_operations" ADD CONSTRAINT "capsule_operations_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operations" ADD CONSTRAINT "capsule_operations_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshots" ADD CONSTRAINT "capsule_snapshots_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshots" ADD CONSTRAINT "capsule_snapshots_source_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("source_branch_id") REFERENCES "capsule_branches"("id");--> statement-breakpoint
ALTER TABLE "capsules" ADD CONSTRAINT "capsules_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;