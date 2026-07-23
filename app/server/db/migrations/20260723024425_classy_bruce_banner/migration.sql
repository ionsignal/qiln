CREATE TYPE "capsule_actor_type" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "capsule_artifact_entry_type" AS ENUM('file', 'directory');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_cleanup_policy" AS ENUM('delete_with_branch', 'retain', 'external');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_status" AS ENUM('planned', 'creating', 'created', 'deleting', 'deleted', 'adopted', 'missing', 'error');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_type" AS ENUM('incus_project', 'incus_instance', 'zfs_volume', 'bind_mount', 'provisioning_file');--> statement-breakpoint
CREATE TYPE "capsule_branch_status" AS ENUM('provisioning', 'offline', 'starting', 'online', 'stopping', 'destroying', 'destroyed', 'error', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_lifecycle_status" AS ENUM('provisioning', 'active', 'archiving', 'unarchiving', 'destroying', 'destroyed', 'creation_failed', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_operation_status" AS ENUM('accepted', 'running', 'completed', 'failed', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_operation_step_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "capsule_operation_type" AS ENUM('create', 'archive', 'unarchive', 'destroy');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_dependency_digest_kind" AS ENUM('content', 'catalog');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_dependency_kind" AS ENUM('model_vault');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_git_remote_transport" AS ENUM('https', 'ssh');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_resource_kind" AS ENUM('custom_volume_snapshot');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_resource_provider" AS ENUM('incus');--> statement-breakpoint
CREATE TABLE "capsule_artifact_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"manifest_root_id" uuid NOT NULL,
	"logical_path" text NOT NULL,
	"type" "capsule_artifact_entry_type" NOT NULL,
	"mode" text NOT NULL,
	"uid" integer NOT NULL,
	"gid" integer NOT NULL,
	"modified_at" timestamp(3) with time zone NOT NULL,
	"size" bigint,
	"content_digest" text,
	CONSTRAINT "capsule_artifact_entries_mode_check" CHECK ("mode" ~ '^[0-7]{4}$'),
	CONSTRAINT "capsule_artifact_entries_uid_check" CHECK ("uid" >= 0),
	CONSTRAINT "capsule_artifact_entries_gid_check" CHECK ("gid" >= 0),
	CONSTRAINT "capsule_artifact_entries_file_fields_check" CHECK ((
          (
            "type" = 'file'
            AND "size" IS NOT NULL
            AND "size" >= 0
            AND "size" <= 9007199254740991
            AND "content_digest" IS NOT NULL
            AND "content_digest" ~ '^sha256:[a-f0-9]{64}$'
          )
          OR
          (
            "type" = 'directory'
            AND "size" IS NULL
            AND "content_digest" IS NULL
          )
        ))
);
--> statement-breakpoint
CREATE TABLE "capsule_artifact_manifest_roots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"manifest_id" uuid NOT NULL,
	"root_id" text NOT NULL,
	"logical_path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capsule_artifact_manifests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"snapshot_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capsule_artifact_manifests_schema_version_check" CHECK ("schema_version" = 1),
	CONSTRAINT "capsule_artifact_manifests_digest_check" CHECK ("digest" ~ '^sha256:[a-f0-9]{64}$')
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
	"blueprint_volume_name" text,
	"status" "capsule_branch_resource_status" DEFAULT 'planned'::"capsule_branch_resource_status" NOT NULL,
	"cleanup_policy" "capsule_branch_resource_cleanup_policy" NOT NULL,
	"metadata" jsonb,
	"failure_code" text,
	"failure_message" text,
	"failure_details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capsule_branch_resources_blueprint_volume_check" CHECK ((
          (
            "resource_type" IN ('zfs_volume', 'bind_mount')
            AND "blueprint_volume_name" IS NOT NULL
          )
          OR
          (
            "resource_type" NOT IN ('zfs_volume', 'bind_mount')
            AND "blueprint_volume_name" IS NULL
          )
        ))
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
CREATE TABLE "capsule_snapshot_capture_operations" (
	"operation_id" uuid PRIMARY KEY,
	"source_branch_id" uuid NOT NULL,
	"source_branch_name" text NOT NULL,
	"source_branch_resource_inventory_digest" text NOT NULL,
	"capture_policy_schema_version" integer NOT NULL,
	"capture_policy_digest" text NOT NULL,
	"capture_policy_pin" jsonb NOT NULL,
	"snapshot_id" uuid,
	CONSTRAINT "capsule_snapshot_capture_operations_policy_schema_check" CHECK ("capture_policy_schema_version" = 1),
	CONSTRAINT "capsule_snapshot_capture_operations_policy_digest_check" CHECK ("capture_policy_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_snapshot_capture_operations_inventory_digest_check" CHECK ("source_branch_resource_inventory_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "capsule_snapshot_dependency_references" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"snapshot_id" uuid NOT NULL,
	"manifest_root_id" uuid NOT NULL,
	"source_branch_resource_id" uuid NOT NULL,
	"kind" "capsule_snapshot_dependency_kind" NOT NULL,
	"logical_id" text NOT NULL,
	"blueprint_volume_name" text NOT NULL,
	"revision" text NOT NULL,
	"digest_kind" "capsule_snapshot_dependency_digest_kind" NOT NULL,
	"digest" text NOT NULL,
	CONSTRAINT "capsule_snap_dependency_ref_revision_check" CHECK (length(btrim("revision")) BETWEEN 1 AND 512),
	CONSTRAINT "capsule_snap_dependency_ref_digest_check" CHECK ("digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "capsule_snapshot_git_remotes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"repository_id" uuid NOT NULL,
	"name" text NOT NULL,
	"transport" "capsule_snapshot_git_remote_transport" NOT NULL,
	"host" text NOT NULL,
	"port" integer,
	"repository_path" text NOT NULL,
	CONSTRAINT "capsule_snapshot_git_remotes_port_check" CHECK ("port" IS NULL OR ("port" >= 1 AND "port" <= 65535)),
	CONSTRAINT "capsule_snapshot_git_remotes_host_check" CHECK ((
          "host" <> ''
          AND "host" = lower("host")
          AND "host" !~ '[@/?#]'
        )),
	CONSTRAINT "capsule_snapshot_git_remotes_path_check" CHECK ("repository_path" LIKE '/%' AND "repository_path" !~ '[?#]')
);
--> statement-breakpoint
CREATE TABLE "capsule_snapshot_git_repositories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"snapshot_id" uuid NOT NULL,
	"manifest_root_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"path" text NOT NULL,
	"logical_path" text NOT NULL,
	"head_commit" text,
	"head_reference" text,
	"detached" boolean NOT NULL,
	"index_dirty" boolean NOT NULL,
	"worktree_dirty" boolean NOT NULL,
	"untracked" boolean NOT NULL,
	CONSTRAINT "capsule_snapshot_git_repositories_head_check" CHECK ((
          (
            "detached" = true
            AND "head_commit" IS NOT NULL
            AND "head_reference" IS NULL
          )
          OR
          (
            "detached" = false
            AND "head_reference" IS NOT NULL
          )
        )),
	CONSTRAINT "capsule_snapshot_git_repositories_commit_check" CHECK ((
          "head_commit" IS NULL
          OR "head_commit" ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'
        ))
);
--> statement-breakpoint
CREATE TABLE "capsule_snapshot_resource_references" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"snapshot_id" uuid NOT NULL,
	"manifest_root_id" uuid NOT NULL,
	"source_branch_resource_id" uuid NOT NULL,
	"provider" "capsule_snapshot_resource_provider" NOT NULL,
	"kind" "capsule_snapshot_resource_kind" NOT NULL,
	"blueprint_volume_name" text NOT NULL,
	"project" text NOT NULL,
	"pool" text NOT NULL,
	"source_volume" text NOT NULL,
	"snapshot_name" text NOT NULL,
	CONSTRAINT "capsule_snap_resource_ref_identity_check" CHECK ((
          length(btrim("project")) BETWEEN 1 AND 255
          AND length(btrim("pool")) BETWEEN 1 AND 255
          AND length(btrim("source_volume")) BETWEEN 1 AND 255
          AND length(btrim("snapshot_name")) BETWEEN 1 AND 255
        ))
);
--> statement-breakpoint
CREATE TABLE "capsule_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"capsule_id" uuid NOT NULL,
	"source_branch_id" uuid NOT NULL,
	"source_branch_name" text NOT NULL,
	"source_branch_resource_inventory_digest" text NOT NULL,
	"capture_policy_schema_version" integer NOT NULL,
	"capture_policy_digest" text NOT NULL,
	"capture_policy_pin" jsonb NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp(3) with time zone,
	CONSTRAINT "capsule_snapshots_policy_schema_check" CHECK ("capture_policy_schema_version" = 1),
	CONSTRAINT "capsule_snapshots_policy_digest_check" CHECK ("capture_policy_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_snapshots_inventory_digest_check" CHECK ("source_branch_resource_inventory_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_snapshots_archive_timestamp_check" CHECK ("archived_at" IS NULL OR "archived_at" >= "created_at")
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
CREATE INDEX "capsule_artifact_entries_root_idx" ON "capsule_artifact_entries" ("manifest_root_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_artifact_entries_root_path_unique_idx" ON "capsule_artifact_entries" ("manifest_root_id","logical_path");--> statement-breakpoint
CREATE INDEX "capsule_artifact_manifest_roots_manifest_idx" ON "capsule_artifact_manifest_roots" ("manifest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_artifact_manifest_roots_manifest_root_unique_idx" ON "capsule_artifact_manifest_roots" ("manifest_id","root_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_artifact_manifest_roots_manifest_path_unique_idx" ON "capsule_artifact_manifest_roots" ("manifest_id","logical_path");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_artifact_manifests_snapshot_unique_idx" ON "capsule_artifact_manifests" ("snapshot_id");--> statement-breakpoint
CREATE INDEX "capsule_artifact_manifests_digest_idx" ON "capsule_artifact_manifests" ("digest");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_owner_idx" ON "capsule_branch_resources" ("owner_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_branch_idx" ON "capsule_branch_resources" ("branch_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_created_by_operation_idx" ON "capsule_branch_resources" ("created_by_operation_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_last_operation_idx" ON "capsule_branch_resources" ("last_operation_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_resource_key_idx" ON "capsule_branch_resources" ("resource_key");--> statement-breakpoint
CREATE INDEX "capsule_branch_resources_blueprint_volume_idx" ON "capsule_branch_resources" ("blueprint_volume_name");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branch_resources_operation_key_unique_idx" ON "capsule_branch_resources" ("created_by_operation_id","resource_key");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branch_resources_branch_key_unique_idx" ON "capsule_branch_resources" ("branch_id","resource_key");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branch_resources_branch_blueprint_volume_unique_idx" ON "capsule_branch_resources" ("branch_id","blueprint_volume_name") WHERE "blueprint_volume_name" IS NOT NULL;--> statement-breakpoint
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
CREATE INDEX "capsule_snapshot_capture_operations_source_branch_idx" ON "capsule_snapshot_capture_operations" ("source_branch_id");--> statement-breakpoint
CREATE INDEX "capsule_snapshot_capture_operations_policy_digest_idx" ON "capsule_snapshot_capture_operations" ("capture_policy_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snapshot_capture_operations_snapshot_unique_idx" ON "capsule_snapshot_capture_operations" ("snapshot_id");--> statement-breakpoint
CREATE INDEX "capsule_snap_dependency_ref_snapshot_idx" ON "capsule_snapshot_dependency_references" ("snapshot_id");--> statement-breakpoint
CREATE INDEX "capsule_snap_dependency_ref_root_idx" ON "capsule_snapshot_dependency_references" ("manifest_root_id");--> statement-breakpoint
CREATE INDEX "capsule_snap_dependency_ref_source_resource_idx" ON "capsule_snapshot_dependency_references" ("source_branch_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snap_dependency_ref_snapshot_identity_unique_idx" ON "capsule_snapshot_dependency_references" ("snapshot_id","kind","logical_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snap_dependency_ref_snapshot_volume_unique_idx" ON "capsule_snapshot_dependency_references" ("snapshot_id","blueprint_volume_name");--> statement-breakpoint
CREATE INDEX "capsule_snapshot_git_remotes_repository_idx" ON "capsule_snapshot_git_remotes" ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snapshot_git_remotes_repository_name_unique_idx" ON "capsule_snapshot_git_remotes" ("repository_id","name");--> statement-breakpoint
CREATE INDEX "capsule_snapshot_git_repositories_snapshot_idx" ON "capsule_snapshot_git_repositories" ("snapshot_id");--> statement-breakpoint
CREATE INDEX "capsule_snapshot_git_repositories_root_idx" ON "capsule_snapshot_git_repositories" ("manifest_root_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snapshot_git_repositories_snapshot_id_unique_idx" ON "capsule_snapshot_git_repositories" ("snapshot_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snapshot_git_repositories_snapshot_location_unique_idx" ON "capsule_snapshot_git_repositories" ("snapshot_id","manifest_root_id","path");--> statement-breakpoint
CREATE INDEX "capsule_snap_resource_ref_snapshot_idx" ON "capsule_snapshot_resource_references" ("snapshot_id");--> statement-breakpoint
CREATE INDEX "capsule_snap_resource_ref_root_idx" ON "capsule_snapshot_resource_references" ("manifest_root_id");--> statement-breakpoint
CREATE INDEX "capsule_snap_resource_ref_source_resource_idx" ON "capsule_snapshot_resource_references" ("source_branch_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snap_resource_ref_snapshot_root_unique_idx" ON "capsule_snapshot_resource_references" ("snapshot_id","manifest_root_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snap_resource_ref_snapshot_volume_unique_idx" ON "capsule_snapshot_resource_references" ("snapshot_id","blueprint_volume_name");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snap_resource_ref_provider_identity_unique_idx" ON "capsule_snapshot_resource_references" ("provider","project","pool","source_volume","snapshot_name");--> statement-breakpoint
CREATE INDEX "capsule_snapshots_capsule_created_idx" ON "capsule_snapshots" ("capsule_id","created_at");--> statement-breakpoint
CREATE INDEX "capsule_snapshots_source_branch_idx" ON "capsule_snapshots" ("source_branch_id");--> statement-breakpoint
CREATE INDEX "capsule_snapshots_policy_digest_idx" ON "capsule_snapshots" ("capture_policy_digest");--> statement-breakpoint
CREATE INDEX "capsules_owner_idx" ON "capsules" ("owner_id");--> statement-breakpoint
CREATE INDEX "capsules_owner_lifecycle_status_idx" ON "capsules" ("owner_id","lifecycle_status");--> statement-breakpoint
ALTER TABLE "capsule_artifact_entries" ADD CONSTRAINT "capsule_artifact_entries_mrkPSpdKYhcL_fkey" FOREIGN KEY ("manifest_root_id") REFERENCES "capsule_artifact_manifest_roots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_artifact_manifest_roots" ADD CONSTRAINT "capsule_artifact_manifest_roots_26UCvpd2Xqy4_fkey" FOREIGN KEY ("manifest_id") REFERENCES "capsule_artifact_manifests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_artifact_manifests" ADD CONSTRAINT "capsule_artifact_manifests_BI2edSDiAuzg_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE CASCADE;--> statement-breakpoint
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
ALTER TABLE "capsule_snapshot_capture_operations" ADD CONSTRAINT "capsule_snapshot_capture_operations_ZhOFScnh8rYr_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_operations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_capture_operations" ADD CONSTRAINT "capsule_snapshot_capture_operations_TxTm0hyZaclE_fkey" FOREIGN KEY ("source_branch_id") REFERENCES "capsule_branches"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_capture_operations" ADD CONSTRAINT "capsule_snapshot_capture_operations_viOaGFWNjtRH_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_dependency_references" ADD CONSTRAINT "capsule_snapshot_dependency_references_JzcghoDeWZIG_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_dependency_references" ADD CONSTRAINT "capsule_snapshot_dependency_references_zgkzWtHStDXh_fkey" FOREIGN KEY ("manifest_root_id") REFERENCES "capsule_artifact_manifest_roots"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_dependency_references" ADD CONSTRAINT "capsule_snapshot_dependency_references_aKRwtCdXJbzq_fkey" FOREIGN KEY ("source_branch_resource_id") REFERENCES "capsule_branch_resources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_git_remotes" ADD CONSTRAINT "capsule_snapshot_git_remotes_tuKeDYvSPPpJ_fkey" FOREIGN KEY ("repository_id") REFERENCES "capsule_snapshot_git_repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_git_repositories" ADD CONSTRAINT "capsule_snapshot_git_repositories_ppYUfc0poN0t_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_git_repositories" ADD CONSTRAINT "capsule_snapshot_git_repositories_y4eaRIq0PmAu_fkey" FOREIGN KEY ("manifest_root_id") REFERENCES "capsule_artifact_manifest_roots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_resource_references" ADD CONSTRAINT "capsule_snapshot_resource_references_7Dfg2YH3xUvN_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_resource_references" ADD CONSTRAINT "capsule_snapshot_resource_references_MDC6AllcSgX2_fkey" FOREIGN KEY ("manifest_root_id") REFERENCES "capsule_artifact_manifest_roots"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_resource_references" ADD CONSTRAINT "capsule_snapshot_resource_references_0qmkREWAnNs9_fkey" FOREIGN KEY ("source_branch_resource_id") REFERENCES "capsule_branch_resources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshots" ADD CONSTRAINT "capsule_snapshots_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshots" ADD CONSTRAINT "capsule_snapshots_source_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("source_branch_id") REFERENCES "capsule_branches"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsules" ADD CONSTRAINT "capsules_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;