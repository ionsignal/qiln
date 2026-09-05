CREATE TYPE "capsule_snapshot_agent_artifact_content_policy" AS ENUM('deny', 'owner_authorized_unreviewed');--> statement-breakpoint
CREATE TYPE "capsule_actor_type" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "capsule_artifact_entry_type" AS ENUM('file', 'directory');--> statement-breakpoint
CREATE TYPE "capsule_branch_preview_status" AS ENUM('inactive', 'applying', 'verifying', 'active', 'degraded', 'removing', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_cleanup_policy" AS ENUM('delete_with_branch', 'retain', 'external');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_status" AS ENUM('planned', 'creating', 'created', 'deleting', 'deleted', 'adopted', 'missing', 'error');--> statement-breakpoint
CREATE TYPE "capsule_branch_resource_type" AS ENUM('incus_project', 'incus_instance', 'zfs_volume', 'bind_mount', 'provisioning_file');--> statement-breakpoint
CREATE TYPE "capsule_branch_status" AS ENUM('provisioning', 'offline', 'capturing', 'starting', 'online', 'stopping', 'destroying', 'destroyed', 'error', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_lifecycle_status" AS ENUM('provisioning', 'active', 'archiving', 'unarchiving', 'destroying', 'destroyed', 'creation_failed', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_operation_status" AS ENUM('accepted', 'running', 'completed', 'failed', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_operation_step_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "capsule_operation_type" AS ENUM('create', 'fork', 'archive', 'unarchive', 'destroy', 'snapshot_capture', 'promote', 'rollback');--> statement-breakpoint
CREATE TYPE "capsule_route_alias_status" AS ENUM('inactive', 'active', 'mutating', 'cleanup_required', 'retired');--> statement-breakpoint
CREATE TYPE "capsule_route_exposure" AS ENUM('experimental', 'production');--> statement-breakpoint
CREATE TYPE "capsule_route_method" AS ENUM('DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT');--> statement-breakpoint
CREATE TYPE "capsule_route_provider" AS ENUM('caddy');--> statement-breakpoint
CREATE TYPE "capsule_route_provider_status" AS ENUM('planned', 'applying', 'applied', 'verifying', 'verified', 'failed', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_route_revision_action" AS ENUM('promote', 'rollback');--> statement-breakpoint
CREATE TYPE "capsule_route_revision_status" AS ENUM('proposed', 'committed', 'failed', 'cleanup_required');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_capture_resource_status" AS ENUM('planned', 'creating', 'created', 'deleting', 'deleted', 'missing', 'error');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_dependency_digest_kind" AS ENUM('content', 'catalog');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_dependency_kind" AS ENUM('model_vault');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_git_remote_transport" AS ENUM('https', 'ssh');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_mode" AS ENUM('experimental', 'hardened');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_resource_kind" AS ENUM('custom_volume_snapshot');--> statement-breakpoint
CREATE TYPE "capsule_snapshot_resource_provider" AS ENUM('incus');--> statement-breakpoint
CREATE TYPE "ssh_branch_access_block_reason" AS ENUM('branch_created', 'branch_forked', 'branch_stop', 'snapshot_capture', 'capsule_archive', 'capsule_destroy', 'admin_revoked', 'policy_failure');--> statement-breakpoint
CREATE TYPE "ssh_branch_access_state" AS ENUM('blocked', 'enabled');--> statement-breakpoint
CREATE TYPE "ssh_branch_grant_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "ssh_public_key_algorithm" AS ENUM('ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521');--> statement-breakpoint
CREATE TYPE "ssh_public_key_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "ssh_relay_status" AS ENUM('opening', 'active', 'closing', 'closed');--> statement-breakpoint
CREATE TYPE "ssh_ticket_status" AS ENUM('issued', 'redeemed', 'revoked');--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY,
	"key_hash" text NOT NULL,
	"agent_actor_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"capsule_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "capsule_branch_previews" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"capsule_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"application_name" text NOT NULL,
	"application_pin" jsonb NOT NULL,
	"host" text NOT NULL,
	"provider_route_id" text NOT NULL,
	"status" "capsule_branch_preview_status" DEFAULT 'inactive'::"capsule_branch_preview_status" NOT NULL,
	"withdrawal_requested_at" timestamp(3) with time zone,
	"current_runtime_ip" text,
	"current_configuration_key" text,
	"current_configuration_digest" text,
	"current_configuration" jsonb,
	"pending_runtime_ip" text,
	"pending_configuration_key" text,
	"pending_configuration_digest" text,
	"pending_configuration" jsonb,
	"apply_intent_at" timestamp(3) with time zone,
	"applied_at" timestamp(3) with time zone,
	"verification_intent_at" timestamp(3) with time zone,
	"verification_evidence" jsonb,
	"verified_at" timestamp(3) with time zone,
	"remove_intent_at" timestamp(3) with time zone,
	"failure_code" text,
	"failure_message" text,
	"failure_details" jsonb,
	"failure_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capsule_branch_previews_host_check" CHECK ((
          length("host") BETWEEN 3 AND 253
          AND "host" = lower("host")
          AND "host" !~ '[*><@/?#]'
          AND "host" !~ '\.$'
        )),
	CONSTRAINT "capsule_branch_previews_provider_route_id_check" CHECK ("provider_route_id" ~ '^qiln-preview-[a-z0-9](?:[a-z0-9-]{0,113}[a-z0-9])?$'),
	CONSTRAINT "capsule_branch_previews_current_configuration_check" CHECK ((
          (
            "current_runtime_ip" IS NULL
            AND "current_configuration_key" IS NULL
            AND "current_configuration_digest" IS NULL
            AND "current_configuration" IS NULL
            AND "applied_at" IS NULL
          )
          OR
          (
            "current_runtime_ip" IS NOT NULL
            AND "current_configuration_key" IS NOT NULL
            AND "current_configuration_digest" IS NOT NULL
            AND "current_configuration" IS NOT NULL
            AND jsonb_typeof("current_configuration") = 'object'
            AND "applied_at" IS NOT NULL
          )
        )),
	CONSTRAINT "capsule_branch_previews_pending_configuration_check" CHECK ((
          (
            "pending_runtime_ip" IS NULL
            AND "pending_configuration_key" IS NULL
            AND "pending_configuration_digest" IS NULL
            AND "pending_configuration" IS NULL
            AND "apply_intent_at" IS NULL
          )
          OR
          (
            "pending_runtime_ip" IS NOT NULL
            AND "pending_configuration_key" IS NOT NULL
            AND "pending_configuration_digest" IS NOT NULL
            AND "pending_configuration" IS NOT NULL
            AND jsonb_typeof("pending_configuration") = 'object'
            AND "apply_intent_at" IS NOT NULL
          )
        )),
	CONSTRAINT "capsule_branch_previews_current_runtime_ip_check" CHECK ("current_runtime_ip" IS NULL OR length(btrim("current_runtime_ip")) BETWEEN 1 AND 255),
	CONSTRAINT "capsule_branch_previews_pending_runtime_ip_check" CHECK ("pending_runtime_ip" IS NULL OR length(btrim("pending_runtime_ip")) BETWEEN 1 AND 255),
	CONSTRAINT "capsule_branch_previews_current_configuration_digest_check" CHECK ((
          "current_configuration_digest" IS NULL
          OR "current_configuration_digest" ~ '^sha256:[a-f0-9]{64}$'
        )),
	CONSTRAINT "capsule_branch_previews_pending_configuration_digest_check" CHECK ((
          "pending_configuration_digest" IS NULL
          OR "pending_configuration_digest" ~ '^sha256:[a-f0-9]{64}$'
        )),
	CONSTRAINT "capsule_branch_previews_verification_check" CHECK ((
          (
            "verification_intent_at" IS NULL
            AND "verification_evidence" IS NULL
            AND "verified_at" IS NULL
          )
          OR
          (
            "current_runtime_ip" IS NOT NULL
            AND "verification_intent_at" IS NOT NULL
            AND "verification_evidence" IS NULL
            AND "verified_at" IS NULL
          )
          OR
          (
            "current_runtime_ip" IS NOT NULL
            AND "verification_intent_at" IS NOT NULL
            AND "verification_evidence" IS NOT NULL
            AND "verified_at" IS NOT NULL
          )
        )),
	CONSTRAINT "capsule_branch_previews_remove_intent_check" CHECK ((
          "remove_intent_at" IS NULL
          OR (
            "current_runtime_ip" IS NOT NULL
            AND "pending_runtime_ip" IS NULL
          )
        )),
	CONSTRAINT "capsule_branch_previews_status_check" CHECK ((
          (
            "status" = 'inactive'
            AND "current_runtime_ip" IS NULL
            AND "pending_runtime_ip" IS NULL
            AND "verification_intent_at" IS NULL
            AND "verification_evidence" IS NULL
            AND "verified_at" IS NULL
            AND "remove_intent_at" IS NULL
          )
          OR
          (
            "status" = 'applying'
            AND "pending_runtime_ip" IS NOT NULL
            AND "remove_intent_at" IS NULL
          )
          OR
          (
            "status" = 'verifying'
            AND "current_runtime_ip" IS NOT NULL
            AND "pending_runtime_ip" IS NULL
            AND "verification_intent_at" IS NOT NULL
            AND "verification_evidence" IS NULL
            AND "verified_at" IS NULL
            AND "remove_intent_at" IS NULL
          )
          OR
          (
            "status" = 'active'
            AND "current_runtime_ip" IS NOT NULL
            AND "pending_runtime_ip" IS NULL
            AND "verification_intent_at" IS NOT NULL
            AND "verification_evidence" IS NOT NULL
            AND "verified_at" IS NOT NULL
            AND "remove_intent_at" IS NULL
          )
          OR
          (
            "status" = 'degraded'
            AND "current_runtime_ip" IS NOT NULL
            AND "pending_runtime_ip" IS NULL
            AND "remove_intent_at" IS NULL
          )
          OR
          (
            "status" = 'removing'
            AND "current_runtime_ip" IS NOT NULL
            AND "pending_runtime_ip" IS NULL
            AND "remove_intent_at" IS NOT NULL
          )
          OR
          "status" = 'cleanup_required'
        )),
	CONSTRAINT "capsule_branch_previews_failure_check" CHECK ((
          (
            "status" IN ('degraded', 'cleanup_required')
            AND "failure_code" IS NOT NULL
            AND "failure_message" IS NOT NULL
            AND "failure_details" IS NOT NULL
            AND "failure_at" IS NOT NULL
          )
          OR
          (
            "status" NOT IN ('degraded', 'cleanup_required')
            AND "failure_code" IS NULL
            AND "failure_message" IS NULL
            AND "failure_details" IS NULL
            AND "failure_at" IS NULL
          )
        )),
	CONSTRAINT "capsule_branch_previews_timestamp_order_check" CHECK ((
          (
            "verification_intent_at" IS NULL
            OR (
              "applied_at" IS NOT NULL
              AND "verification_intent_at" >= "applied_at"
            )
          )
          AND
          (
            "verified_at" IS NULL
            OR (
              "verification_intent_at" IS NOT NULL
              AND "verified_at" >= "verification_intent_at"
            )
          )
          AND
          (
            "remove_intent_at" IS NULL
            OR (
              "applied_at" IS NOT NULL
              AND "remove_intent_at" >= "applied_at"
            )
          )
        ))
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
	CONSTRAINT "capsule_branches_inactive_runtime_ip_check" CHECK ((
          "status" NOT IN ('offline', 'capturing')
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
	"rootfs_image_pin" jsonb NOT NULL,
	"cpu" text NOT NULL,
	"memory" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capsule_fork_operations" (
	"operation_id" uuid PRIMARY KEY,
	"source_snapshot_id" uuid NOT NULL,
	"target_branch_id" uuid NOT NULL,
	"target_branch_name" text NOT NULL,
	"target_branch_resource_inventory_digest" text NOT NULL,
	"blueprint_schema_version" integer NOT NULL,
	"blueprint_name" text NOT NULL,
	"blueprint_digest" text NOT NULL,
	"blueprint_pin" jsonb NOT NULL,
	"rootfs_image_pin" jsonb NOT NULL,
	"capture_policy_schema_version" integer NOT NULL,
	"capture_policy_digest" text NOT NULL,
	"capture_policy_pin" jsonb NOT NULL,
	"source_snapshot_mode" "capsule_snapshot_mode" NOT NULL,
	"source_snapshot_limitations" jsonb NOT NULL,
	"cpu" text NOT NULL,
	"memory" text NOT NULL,
	CONSTRAINT "capsule_fork_operations_blueprint_schema_check" CHECK ("blueprint_schema_version" = 1),
	CONSTRAINT "capsule_fork_operations_blueprint_digest_check" CHECK ("blueprint_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_fork_operations_policy_schema_check" CHECK ("capture_policy_schema_version" = 1),
	CONSTRAINT "capsule_fork_operations_policy_digest_check" CHECK ("capture_policy_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_fork_operations_inventory_digest_check" CHECK ("target_branch_resource_inventory_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_fork_operations_assurance_check" CHECK ((
          (
            "source_snapshot_mode" = 'experimental'
            AND jsonb_typeof("source_snapshot_limitations") = 'array'
            AND jsonb_array_length("source_snapshot_limitations") > 0
          )
          OR
          (
            "source_snapshot_mode" = 'hardened'
            AND jsonb_typeof("source_snapshot_limitations") = 'array'
            AND jsonb_array_length("source_snapshot_limitations") = 0
          )
        ))
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
CREATE TABLE "capsule_route_aliases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"capsule_id" uuid NOT NULL,
	"name" text NOT NULL,
	"exposure" "capsule_route_exposure" NOT NULL,
	"host" text NOT NULL,
	"path" text NOT NULL,
	"methods" "capsule_route_method"[] NOT NULL,
	"matcher_digest" text NOT NULL,
	"status" "capsule_route_alias_status" DEFAULT 'inactive'::"capsule_route_alias_status" NOT NULL,
	"mutation_operation_id" uuid,
	"last_operation_id" uuid,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capsule_route_aliases_host_check" CHECK ((
          length("host") BETWEEN 3 AND 253
          AND "host" = lower("host")
          AND "host" !~ '[*><@/?#]'
          AND "host" !~ '\.$'
        )),
	CONSTRAINT "capsule_route_aliases_path_check" CHECK ((
          "path" LIKE '/%'
          AND "path" !~ '[?#]'
          AND ("path" = '/' OR "path" !~ '/$')
        )),
	CONSTRAINT "capsule_route_aliases_methods_check" CHECK (cardinality("methods") > 0),
	CONSTRAINT "capsule_route_aliases_matcher_digest_check" CHECK ("matcher_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_route_aliases_mutation_fence_check" CHECK ((
          (
            "status" = 'mutating'
            AND "mutation_operation_id" IS NOT NULL
          )
          OR
          (
            "status" <> 'mutating'
            AND "mutation_operation_id" IS NULL
          )
        ))
);
--> statement-breakpoint
CREATE TABLE "capsule_route_heads" (
	"alias_id" uuid PRIMARY KEY,
	"revision_id" uuid NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capsule_route_operations" (
	"operation_id" uuid PRIMARY KEY,
	"alias_id" uuid NOT NULL,
	"action" "capsule_route_revision_action" NOT NULL,
	"expected_revision_id" uuid,
	"proposed_revision_id" uuid NOT NULL,
	"rollback_source_revision_id" uuid,
	CONSTRAINT "capsule_route_operations_action_check" CHECK ((
          (
            "action" = 'promote'
            AND "rollback_source_revision_id" IS NULL
          )
          OR
          (
            "action" = 'rollback'
            AND "expected_revision_id" IS NOT NULL
            AND "rollback_source_revision_id" IS NOT NULL
          )
        ))
);
--> statement-breakpoint
CREATE TABLE "capsule_route_provider_applications" (
	"operation_id" uuid PRIMARY KEY,
	"revision_id" uuid NOT NULL,
	"provider" "capsule_route_provider" DEFAULT 'caddy'::"capsule_route_provider" NOT NULL,
	"status" "capsule_route_provider_status" DEFAULT 'planned'::"capsule_route_provider_status" NOT NULL,
	"configuration_key" text,
	"configuration_digest" text,
	"configuration" jsonb,
	"apply_intent_at" timestamp(3) with time zone,
	"applied_at" timestamp(3) with time zone,
	"verification_intent_at" timestamp(3) with time zone,
	"verification_evidence" jsonb,
	"verified_at" timestamp(3) with time zone,
	"failure_code" text,
	"failure_message" text,
	"failure_details" jsonb,
	"failure_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capsule_route_provider_applications_configuration_check" CHECK ((
          (
            "configuration_key" IS NULL
            AND "configuration_digest" IS NULL
            AND "configuration" IS NULL
          )
          OR
          (
            "configuration_key" IS NOT NULL
            AND "configuration_digest" IS NOT NULL
            AND "configuration" IS NOT NULL
          )
        )),
	CONSTRAINT "capsule_route_provider_applications_configuration_digest_check" CHECK ((
          "configuration_digest" IS NULL
          OR "configuration_digest" ~ '^sha256:[a-f0-9]{64}$'
        )),
	CONSTRAINT "capsule_route_provider_applications_mutation_check" CHECK ((
          "status" IN ('planned', 'failed', 'cleanup_required')
          OR (
            "configuration_key" IS NOT NULL
            AND "configuration_digest" IS NOT NULL
            AND "configuration" IS NOT NULL
          )
        )),
	CONSTRAINT "capsule_route_provider_applications_timeline_check" CHECK ((
          (
            "status" = 'planned'
            AND "apply_intent_at" IS NULL
            AND "applied_at" IS NULL
            AND "verification_intent_at" IS NULL
            AND "verification_evidence" IS NULL
            AND "verified_at" IS NULL
          )
          OR
          (
            "status" = 'applying'
            AND "apply_intent_at" IS NOT NULL
            AND "applied_at" IS NULL
            AND "verification_intent_at" IS NULL
            AND "verification_evidence" IS NULL
            AND "verified_at" IS NULL
          )
          OR
          (
            "status" = 'applied'
            AND "apply_intent_at" IS NOT NULL
            AND "applied_at" IS NOT NULL
            AND "verification_intent_at" IS NULL
            AND "verification_evidence" IS NULL
            AND "verified_at" IS NULL
          )
          OR
          (
            "status" = 'verifying'
            AND "apply_intent_at" IS NOT NULL
            AND "applied_at" IS NOT NULL
            AND "verification_intent_at" IS NOT NULL
            AND "verification_evidence" IS NULL
            AND "verified_at" IS NULL
          )
          OR
          (
            "status" = 'verified'
            AND "apply_intent_at" IS NOT NULL
            AND "applied_at" IS NOT NULL
            AND "verification_intent_at" IS NOT NULL
            AND "verification_evidence" IS NOT NULL
            AND "verified_at" IS NOT NULL
          )
          OR
          (
            "status" IN ('failed', 'cleanup_required')
            AND "failure_at" IS NOT NULL
          )
        )),
	CONSTRAINT "capsule_route_provider_applications_failure_check" CHECK ((
          (
            "status" IN ('failed', 'cleanup_required')
            AND "failure_code" IS NOT NULL
            AND "failure_message" IS NOT NULL
            AND "failure_details" IS NOT NULL
            AND "failure_at" IS NOT NULL
          )
          OR
          (
            "status" NOT IN ('failed', 'cleanup_required')
            AND "failure_code" IS NULL
            AND "failure_message" IS NULL
            AND "failure_details" IS NULL
            AND "failure_at" IS NULL
          )
        )),
	CONSTRAINT "capsule_route_provider_applications_timestamp_order_check" CHECK ((
          (
            "applied_at" IS NULL
            OR (
              "apply_intent_at" IS NOT NULL
              AND "applied_at" >= "apply_intent_at"
            )
          )
          AND
          (
            "verification_intent_at" IS NULL
            OR (
              "applied_at" IS NOT NULL
              AND "verification_intent_at" >= "applied_at"
            )
          )
          AND
          (
            "verified_at" IS NULL
            OR (
              "verification_intent_at" IS NOT NULL
              AND "verified_at" >= "verification_intent_at"
            )
          )
        ))
);
--> statement-breakpoint
CREATE TABLE "capsule_route_revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"alias_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"action" "capsule_route_revision_action" NOT NULL,
	"previous_revision_id" uuid,
	"rollback_source_revision_id" uuid,
	"snapshot_id" uuid NOT NULL,
	"target_pin" jsonb NOT NULL,
	"evidence_pin" jsonb NOT NULL,
	"operation_id" uuid NOT NULL,
	"status" "capsule_route_revision_status" DEFAULT 'proposed'::"capsule_route_revision_status" NOT NULL,
	"proposed_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp(3) with time zone,
	"failed_at" timestamp(3) with time zone,
	CONSTRAINT "capsule_route_revisions_number_check" CHECK ("number" > 0),
	CONSTRAINT "capsule_route_revisions_action_check" CHECK ((
          (
            "action" = 'promote'
            AND "rollback_source_revision_id" IS NULL
          )
          OR
          (
            "action" = 'rollback'
            AND "previous_revision_id" IS NOT NULL
            AND "rollback_source_revision_id" IS NOT NULL
          )
        )),
	CONSTRAINT "capsule_route_revisions_terminal_state_check" CHECK ((
          (
            "status" = 'proposed'
            AND "committed_at" IS NULL
            AND "failed_at" IS NULL
          )
          OR
          (
            "status" = 'committed'
            AND "committed_at" IS NOT NULL
            AND "failed_at" IS NULL
          )
          OR
          (
            "status" IN ('failed', 'cleanup_required')
            AND "committed_at" IS NULL
            AND "failed_at" IS NOT NULL
          )
        )),
	CONSTRAINT "capsule_route_revisions_timestamp_order_check" CHECK ((
          ("committed_at" IS NULL OR "committed_at" >= "proposed_at")
          AND
          ("failed_at" IS NULL OR "failed_at" >= "proposed_at")
        ))
);
--> statement-breakpoint
CREATE TABLE "capsule_snapshot_capture_operations" (
	"operation_id" uuid PRIMARY KEY,
	"source_branch_id" uuid NOT NULL,
	"source_branch_name" text NOT NULL,
	"source_branch_resource_inventory_digest" text NOT NULL,
	"blueprint_schema_version" integer NOT NULL,
	"blueprint_name" text NOT NULL,
	"blueprint_digest" text NOT NULL,
	"blueprint_pin" jsonb NOT NULL,
	"rootfs_image_pin" jsonb NOT NULL,
	"capture_policy_schema_version" integer NOT NULL,
	"capture_policy_digest" text NOT NULL,
	"capture_policy_pin" jsonb NOT NULL,
	"requested_mode" "capsule_snapshot_mode" DEFAULT 'experimental'::"capsule_snapshot_mode" NOT NULL,
	"agent_artifact_content_policy" "capsule_snapshot_agent_artifact_content_policy" DEFAULT 'deny'::"capsule_snapshot_agent_artifact_content_policy" NOT NULL,
	"snapshot_id" uuid,
	CONSTRAINT "capsule_snapshot_capture_operations_blueprint_schema_check" CHECK ("blueprint_schema_version" = 1),
	CONSTRAINT "capsule_snapshot_capture_operations_blueprint_digest_check" CHECK ("blueprint_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_snapshot_capture_operations_policy_schema_check" CHECK ("capture_policy_schema_version" = 1),
	CONSTRAINT "capsule_snapshot_capture_operations_policy_digest_check" CHECK ("capture_policy_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_snapshot_capture_operations_inventory_digest_check" CHECK ("source_branch_resource_inventory_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "capsule_snapshot_capture_resources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"operation_id" uuid NOT NULL,
	"source_branch_resource_id" uuid NOT NULL,
	"artifact_root_id" text NOT NULL,
	"blueprint_volume_name" text NOT NULL,
	"provider" "capsule_snapshot_resource_provider" NOT NULL,
	"kind" "capsule_snapshot_resource_kind" NOT NULL,
	"project" text NOT NULL,
	"pool" text NOT NULL,
	"source_volume" text NOT NULL,
	"snapshot_name" text NOT NULL,
	"status" "capsule_snapshot_capture_resource_status" DEFAULT 'planned'::"capsule_snapshot_capture_resource_status" NOT NULL,
	"snapshot_intent_at" timestamp with time zone,
	"snapshot_created_at" timestamp with time zone,
	"cleanup_intent_at" timestamp with time zone,
	"cleanup_completed_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"failure_details" jsonb,
	"failure_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capsule_snapshot_capture_resources_identity_check" CHECK ((
          length(btrim("project")) BETWEEN 1 AND 255
          AND length(btrim("pool")) BETWEEN 1 AND 255
          AND length(btrim("source_volume")) BETWEEN 1 AND 255
          AND length(btrim("snapshot_name")) BETWEEN 1 AND 255
        )),
	CONSTRAINT "capsule_snapshot_capture_resources_timeline_check" CHECK ((
          (
            "status" = 'planned'
            AND "snapshot_intent_at" IS NULL
            AND "snapshot_created_at" IS NULL
            AND "cleanup_intent_at" IS NULL
            AND "cleanup_completed_at" IS NULL
          )
          OR
          (
            "status" = 'creating'
            AND "snapshot_intent_at" IS NOT NULL
            AND "snapshot_created_at" IS NULL
            AND "cleanup_intent_at" IS NULL
            AND "cleanup_completed_at" IS NULL
          )
          OR
          (
            "status" = 'created'
            AND "snapshot_intent_at" IS NOT NULL
            AND "snapshot_created_at" IS NOT NULL
            AND "cleanup_intent_at" IS NULL
            AND "cleanup_completed_at" IS NULL
          )
          OR
          (
            "status" = 'deleting'
            AND "snapshot_intent_at" IS NOT NULL
            AND "snapshot_created_at" IS NOT NULL
            AND "cleanup_intent_at" IS NOT NULL
            AND "cleanup_completed_at" IS NULL
          )
          OR
          (
            "status" IN ('deleted', 'missing')
            AND "snapshot_intent_at" IS NOT NULL
            AND "snapshot_created_at" IS NOT NULL
            AND "cleanup_intent_at" IS NOT NULL
            AND "cleanup_completed_at" IS NOT NULL
          )
          OR
          (
            "status" = 'error'
            AND "snapshot_intent_at" IS NOT NULL
          )
        )),
	CONSTRAINT "capsule_snapshot_capture_resources_failure_check" CHECK ((
          (
            "status" = 'error'
            AND "failure_code" IS NOT NULL
            AND "failure_message" IS NOT NULL
            AND "failure_details" IS NOT NULL
            AND "failure_at" IS NOT NULL
          )
          OR
          (
            "status" <> 'error'
            AND "failure_code" IS NULL
            AND "failure_message" IS NULL
            AND "failure_details" IS NULL
            AND "failure_at" IS NULL
          )
        )),
	CONSTRAINT "capsule_snapshot_capture_resources_timestamp_order_check" CHECK ((
          (
            "snapshot_created_at" IS NULL
            OR (
              "snapshot_intent_at" IS NOT NULL
              AND "snapshot_created_at" >= "snapshot_intent_at"
            )
          )
          AND
          (
            "cleanup_intent_at" IS NULL
            OR (
              "snapshot_created_at" IS NOT NULL
              AND "cleanup_intent_at" >= "snapshot_created_at"
            )
          )
          AND
          (
            "cleanup_completed_at" IS NULL
            OR (
              "cleanup_intent_at" IS NOT NULL
              AND "cleanup_completed_at" >= "cleanup_intent_at"
            )
          )
        ))
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
	"capture_resource_id" uuid NOT NULL,
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
	"blueprint_schema_version" integer NOT NULL,
	"blueprint_name" text NOT NULL,
	"blueprint_digest" text NOT NULL,
	"blueprint_pin" jsonb NOT NULL,
	"rootfs_image_pin" jsonb NOT NULL,
	"capture_policy_schema_version" integer NOT NULL,
	"capture_policy_digest" text NOT NULL,
	"capture_policy_pin" jsonb NOT NULL,
	"agent_artifact_content_policy" "capsule_snapshot_agent_artifact_content_policy" DEFAULT 'deny'::"capsule_snapshot_agent_artifact_content_policy" NOT NULL,
	"mode" "capsule_snapshot_mode" DEFAULT 'experimental'::"capsule_snapshot_mode" NOT NULL,
	"limitations" jsonb NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp(3) with time zone,
	CONSTRAINT "capsule_snapshots_blueprint_schema_check" CHECK ("blueprint_schema_version" = 1),
	CONSTRAINT "capsule_snapshots_blueprint_digest_check" CHECK ("blueprint_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_snapshots_policy_schema_check" CHECK ("capture_policy_schema_version" = 1),
	CONSTRAINT "capsule_snapshots_policy_digest_check" CHECK ("capture_policy_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_snapshots_inventory_digest_check" CHECK ("source_branch_resource_inventory_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "capsule_snapshots_assurance_check" CHECK ((
          (
            "mode" = 'experimental'
            AND jsonb_typeof("limitations") = 'array'
            AND jsonb_array_length("limitations") > 0
          )
          OR
          (
            "mode" = 'hardened'
            AND jsonb_typeof("limitations") = 'array'
            AND jsonb_array_length("limitations") = 0
          )
        )),
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
CREATE TABLE "ssh_branch_access" (
	"branch_id" uuid PRIMARY KEY,
	"state" "ssh_branch_access_state" DEFAULT 'blocked'::"ssh_branch_access_state" NOT NULL,
	"block_reason" "ssh_branch_access_block_reason",
	"enabled_at" timestamp(3) with time zone,
	"blocked_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ssh_branch_access_state_check" CHECK ((
        (
          "state" = 'enabled'
          AND "block_reason" IS NULL
          AND "enabled_at" IS NOT NULL
        )
        OR
        (
          "state" = 'blocked'
          AND "block_reason" IS NOT NULL
          AND "blocked_at" IS NOT NULL
        )
      )),
	CONSTRAINT "ssh_branch_access_timestamp_check" CHECK ((
        "enabled_at" IS NULL
        OR "enabled_at" >= "created_at"
      )
      AND
      (
        "blocked_at" IS NULL
        OR "blocked_at" >= "created_at"
      ))
);
--> statement-breakpoint
CREATE TABLE "ssh_branch_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"public_key_id" uuid NOT NULL,
	"key_owner_user_id" uuid NOT NULL,
	"capsule_owner_user_id" uuid NOT NULL,
	"capsule_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"bound_by_admin_user_id" uuid NOT NULL,
	"revoked_by_user_id" uuid,
	"status" "ssh_branch_grant_status" DEFAULT 'active'::"ssh_branch_grant_status" NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp(3) with time zone,
	CONSTRAINT "ssh_branch_grants_state_check" CHECK ((
        (
          "status" = 'active'
          AND "revoked_at" IS NULL
          AND "revoked_by_user_id" IS NULL
        )
        OR
        (
          "status" = 'revoked'
          AND "revoked_at" IS NOT NULL
        )
      )),
	CONSTRAINT "ssh_branch_grants_timestamp_check" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE "ssh_public_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_user_id" uuid NOT NULL,
	"algorithm" "ssh_public_key_algorithm" NOT NULL,
	"public_key_blob" text NOT NULL,
	"fingerprint" text NOT NULL,
	"label" text,
	"status" "ssh_public_key_status" DEFAULT 'active'::"ssh_public_key_status" NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp(3) with time zone,
	CONSTRAINT "ssh_public_keys_state_check" CHECK ((
        (
          "status" = 'active'
          AND "revoked_at" IS NULL
        )
        OR
        (
          "status" = 'revoked'
          AND "revoked_at" IS NOT NULL
        )
      )),
	CONSTRAINT "ssh_public_keys_fingerprint_check" CHECK ("fingerprint" ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
	CONSTRAINT "ssh_public_keys_blob_check" CHECK (length("public_key_blob") BETWEEN 1 AND 16384),
	CONSTRAINT "ssh_public_keys_label_check" CHECK ((
        "label" IS NULL
        OR (
          length(btrim("label")) BETWEEN 1 AND 128
          AND "label" = btrim("label")
          AND "label" !~ '[[:cntrl:]]'
        )
      ))
);
--> statement-breakpoint
CREATE TABLE "ssh_relays" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"ticket_id" uuid NOT NULL,
	"public_key_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"capsule_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"gateway_instance_id" text NOT NULL,
	"status" "ssh_relay_status" DEFAULT 'opening'::"ssh_relay_status" NOT NULL,
	"opened_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp(3) with time zone,
	"closing_at" timestamp(3) with time zone,
	"closed_at" timestamp(3) with time zone,
	"closure_reason" text,
	CONSTRAINT "ssh_relays_gateway_instance_check" CHECK ((
        length(btrim("gateway_instance_id")) BETWEEN 1 AND 128
        AND "gateway_instance_id" = btrim("gateway_instance_id")
        AND "gateway_instance_id" !~ '[[:cntrl:]]'
      )),
	CONSTRAINT "ssh_relays_closure_reason_check" CHECK ((
        "closure_reason" IS NULL
        OR (
          length(btrim("closure_reason")) BETWEEN 1 AND 128
          AND "closure_reason" = btrim("closure_reason")
          AND "closure_reason" !~ '[[:cntrl:]]'
        )
      )),
	CONSTRAINT "ssh_relays_state_check" CHECK ((
        (
          "status" = 'opening'
          AND "activated_at" IS NULL
          AND "closing_at" IS NULL
          AND "closed_at" IS NULL
          AND "closure_reason" IS NULL
        )
        OR
        (
          "status" = 'active'
          AND "activated_at" IS NOT NULL
          AND "closing_at" IS NULL
          AND "closed_at" IS NULL
          AND "closure_reason" IS NULL
        )
        OR
        (
          "status" = 'closing'
          AND "closing_at" IS NOT NULL
          AND "closed_at" IS NULL
          AND "closure_reason" IS NOT NULL
        )
        OR
        (
          "status" = 'closed'
          AND "closing_at" IS NOT NULL
          AND "closed_at" IS NOT NULL
          AND "closure_reason" IS NOT NULL
        )
      )),
	CONSTRAINT "ssh_relays_timestamp_check" CHECK ((
        "activated_at" IS NULL
        OR "activated_at" >= "opened_at"
      )
      AND
      (
        "closing_at" IS NULL
        OR "closing_at" >= "opened_at"
      )
      AND
      (
        "closed_at" IS NULL
        OR (
          "closing_at" IS NOT NULL
          AND "closed_at" >= "closing_at"
        )
      ))
);
--> statement-breakpoint
CREATE TABLE "ssh_tickets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"ticket_hash" text NOT NULL,
	"public_key_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"capsule_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" "ssh_ticket_status" DEFAULT 'issued'::"ssh_ticket_status" NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"issued_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp(3) with time zone,
	"revoked_at" timestamp(3) with time zone,
	CONSTRAINT "ssh_tickets_hash_check" CHECK ("ticket_hash" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "ssh_tickets_expiry_check" CHECK ("expires_at" > "issued_at"),
	CONSTRAINT "ssh_tickets_state_check" CHECK ((
        (
          "status" = 'issued'
          AND "redeemed_at" IS NULL
          AND "revoked_at" IS NULL
        )
        OR
        (
          "status" = 'redeemed'
          AND "redeemed_at" IS NOT NULL
          AND "revoked_at" IS NULL
        )
        OR
        (
          "status" = 'revoked'
          AND "revoked_at" IS NOT NULL
        )
      )),
	CONSTRAINT "ssh_tickets_timestamp_check" CHECK ((
        "redeemed_at" IS NULL
        OR "redeemed_at" >= "issued_at"
      )
      AND
      (
        "revoked_at" IS NULL
        OR "revoked_at" >= "issued_at"
      )
      AND
      (
        "redeemed_at" IS NULL
        OR "revoked_at" IS NULL
        OR "revoked_at" >= "redeemed_at"
      ))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"username" text NOT NULL UNIQUE,
	"email" text NOT NULL UNIQUE,
	"password" text NOT NULL,
	"avatar" text DEFAULT 'default' NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_credentials_requested_by_user_idx" ON "agent_credentials" ("requested_by_user_id");--> statement-breakpoint
CREATE INDEX "agent_credentials_capsule_idx" ON "agent_credentials" ("capsule_id");--> statement-breakpoint
CREATE INDEX "agent_credentials_active_idx" ON "agent_credentials" ("is_active");--> statement-breakpoint
CREATE INDEX "capsule_artifact_entries_root_idx" ON "capsule_artifact_entries" ("manifest_root_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_artifact_entries_root_path_unique_idx" ON "capsule_artifact_entries" ("manifest_root_id","logical_path");--> statement-breakpoint
CREATE INDEX "capsule_artifact_manifest_roots_manifest_idx" ON "capsule_artifact_manifest_roots" ("manifest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_artifact_manifest_roots_manifest_root_unique_idx" ON "capsule_artifact_manifest_roots" ("manifest_id","root_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_artifact_manifest_roots_manifest_path_unique_idx" ON "capsule_artifact_manifest_roots" ("manifest_id","logical_path");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_artifact_manifests_snapshot_unique_idx" ON "capsule_artifact_manifests" ("snapshot_id");--> statement-breakpoint
CREATE INDEX "capsule_artifact_manifests_digest_idx" ON "capsule_artifact_manifests" ("digest");--> statement-breakpoint
CREATE INDEX "capsule_branch_previews_owner_idx" ON "capsule_branch_previews" ("owner_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_previews_capsule_idx" ON "capsule_branch_previews" ("capsule_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_previews_branch_idx" ON "capsule_branch_previews" ("branch_id");--> statement-breakpoint
CREATE INDEX "capsule_branch_previews_status_idx" ON "capsule_branch_previews" ("status");--> statement-breakpoint
CREATE INDEX "capsule_branch_previews_withdrawal_requested_idx" ON "capsule_branch_previews" ("withdrawal_requested_at");--> statement-breakpoint
CREATE INDEX "capsule_branch_previews_current_configuration_digest_idx" ON "capsule_branch_previews" ("current_configuration_digest");--> statement-breakpoint
CREATE INDEX "capsule_branch_previews_pending_configuration_digest_idx" ON "capsule_branch_previews" ("pending_configuration_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branch_previews_branch_application_unique_idx" ON "capsule_branch_previews" ("branch_id","application_name");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branch_previews_host_unique_idx" ON "capsule_branch_previews" ("host");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branch_previews_provider_route_id_unique_idx" ON "capsule_branch_previews" ("provider_route_id");--> statement-breakpoint
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
CREATE UNIQUE INDEX "capsule_branches_capsule_runtime_name_unique_idx" ON "capsule_branches" ("capsule_id","name") WHERE "status" <> 'destroyed';--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_branches_capsule_root_unique_idx" ON "capsule_branches" ("capsule_id") WHERE "is_root_branch" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_create_operations_root_branch_unique_idx" ON "capsule_create_operations" ("root_branch_id");--> statement-breakpoint
CREATE INDEX "capsule_fork_operations_source_snapshot_idx" ON "capsule_fork_operations" ("source_snapshot_id");--> statement-breakpoint
CREATE INDEX "capsule_fork_operations_blueprint_digest_idx" ON "capsule_fork_operations" ("blueprint_digest");--> statement-breakpoint
CREATE INDEX "capsule_fork_operations_policy_digest_idx" ON "capsule_fork_operations" ("capture_policy_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_fork_operations_target_branch_unique_idx" ON "capsule_fork_operations" ("target_branch_id");--> statement-breakpoint
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
CREATE INDEX "capsule_route_aliases_owner_idx" ON "capsule_route_aliases" ("owner_id");--> statement-breakpoint
CREATE INDEX "capsule_route_aliases_capsule_idx" ON "capsule_route_aliases" ("capsule_id");--> statement-breakpoint
CREATE INDEX "capsule_route_aliases_status_idx" ON "capsule_route_aliases" ("status");--> statement-breakpoint
CREATE INDEX "capsule_route_aliases_mutation_operation_idx" ON "capsule_route_aliases" ("mutation_operation_id");--> statement-breakpoint
CREATE INDEX "capsule_route_aliases_last_operation_idx" ON "capsule_route_aliases" ("last_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_route_aliases_owner_capsule_name_unique_idx" ON "capsule_route_aliases" ("owner_id","capsule_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_route_aliases_match_unique_idx" ON "capsule_route_aliases" ("host","path");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_route_heads_revision_unique_idx" ON "capsule_route_heads" ("revision_id");--> statement-breakpoint
CREATE INDEX "capsule_route_heads_updated_idx" ON "capsule_route_heads" ("updated_at");--> statement-breakpoint
CREATE INDEX "capsule_route_operations_alias_idx" ON "capsule_route_operations" ("alias_id");--> statement-breakpoint
CREATE INDEX "capsule_route_operations_expected_revision_idx" ON "capsule_route_operations" ("expected_revision_id");--> statement-breakpoint
CREATE INDEX "capsule_route_operations_rollback_source_idx" ON "capsule_route_operations" ("rollback_source_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_route_operations_proposed_revision_unique_idx" ON "capsule_route_operations" ("proposed_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_route_provider_applications_revision_unique_idx" ON "capsule_route_provider_applications" ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_route_provider_applications_key_unique_idx" ON "capsule_route_provider_applications" ("provider","configuration_key") WHERE "configuration_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "capsule_route_provider_applications_status_idx" ON "capsule_route_provider_applications" ("status");--> statement-breakpoint
CREATE INDEX "capsule_route_provider_applications_digest_idx" ON "capsule_route_provider_applications" ("configuration_digest");--> statement-breakpoint
CREATE INDEX "capsule_route_revisions_alias_idx" ON "capsule_route_revisions" ("alias_id");--> statement-breakpoint
CREATE INDEX "capsule_route_revisions_snapshot_idx" ON "capsule_route_revisions" ("snapshot_id");--> statement-breakpoint
CREATE INDEX "capsule_route_revisions_previous_idx" ON "capsule_route_revisions" ("previous_revision_id");--> statement-breakpoint
CREATE INDEX "capsule_route_revisions_rollback_source_idx" ON "capsule_route_revisions" ("rollback_source_revision_id");--> statement-breakpoint
CREATE INDEX "capsule_route_revisions_status_idx" ON "capsule_route_revisions" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_route_revisions_alias_number_unique_idx" ON "capsule_route_revisions" ("alias_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_route_revisions_operation_unique_idx" ON "capsule_route_revisions" ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_route_revisions_alias_id_unique_idx" ON "capsule_route_revisions" ("alias_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_route_revisions_operation_id_unique_idx" ON "capsule_route_revisions" ("operation_id","id");--> statement-breakpoint
CREATE INDEX "capsule_snapshot_capture_operations_source_branch_idx" ON "capsule_snapshot_capture_operations" ("source_branch_id");--> statement-breakpoint
CREATE INDEX "capsule_snapshot_capture_operations_blueprint_digest_idx" ON "capsule_snapshot_capture_operations" ("blueprint_digest");--> statement-breakpoint
CREATE INDEX "capsule_snapshot_capture_operations_policy_digest_idx" ON "capsule_snapshot_capture_operations" ("capture_policy_digest");--> statement-breakpoint
CREATE INDEX "capsule_snapshot_capture_operations_mode_idx" ON "capsule_snapshot_capture_operations" ("requested_mode");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snapshot_capture_operations_snapshot_unique_idx" ON "capsule_snapshot_capture_operations" ("snapshot_id");--> statement-breakpoint
CREATE INDEX "capsule_snapshot_capture_resources_operation_idx" ON "capsule_snapshot_capture_resources" ("operation_id");--> statement-breakpoint
CREATE INDEX "capsule_snapshot_capture_resources_source_resource_idx" ON "capsule_snapshot_capture_resources" ("source_branch_resource_id");--> statement-breakpoint
CREATE INDEX "capsule_snapshot_capture_resources_status_idx" ON "capsule_snapshot_capture_resources" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snapshot_capture_resources_operation_root_unique_idx" ON "capsule_snapshot_capture_resources" ("operation_id","artifact_root_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snapshot_capture_resources_operation_volume_unique_idx" ON "capsule_snapshot_capture_resources" ("operation_id","blueprint_volume_name");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snapshot_capture_resources_operation_source_unique_idx" ON "capsule_snapshot_capture_resources" ("operation_id","source_branch_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snapshot_capture_resources_provider_identity_unique_idx" ON "capsule_snapshot_capture_resources" ("provider","project","pool","source_volume","snapshot_name");--> statement-breakpoint
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
CREATE UNIQUE INDEX "capsule_snap_resource_ref_capture_resource_unique_idx" ON "capsule_snapshot_resource_references" ("capture_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snap_resource_ref_snapshot_root_unique_idx" ON "capsule_snapshot_resource_references" ("snapshot_id","manifest_root_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snap_resource_ref_snapshot_volume_unique_idx" ON "capsule_snapshot_resource_references" ("snapshot_id","blueprint_volume_name");--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_snap_resource_ref_provider_identity_unique_idx" ON "capsule_snapshot_resource_references" ("provider","project","pool","source_volume","snapshot_name");--> statement-breakpoint
CREATE INDEX "capsule_snapshots_capsule_created_idx" ON "capsule_snapshots" ("capsule_id","created_at");--> statement-breakpoint
CREATE INDEX "capsule_snapshots_source_branch_idx" ON "capsule_snapshots" ("source_branch_id");--> statement-breakpoint
CREATE INDEX "capsule_snapshots_blueprint_digest_idx" ON "capsule_snapshots" ("blueprint_digest");--> statement-breakpoint
CREATE INDEX "capsule_snapshots_policy_digest_idx" ON "capsule_snapshots" ("capture_policy_digest");--> statement-breakpoint
CREATE INDEX "capsule_snapshots_mode_idx" ON "capsule_snapshots" ("mode");--> statement-breakpoint
CREATE INDEX "capsules_owner_idx" ON "capsules" ("owner_id");--> statement-breakpoint
CREATE INDEX "capsules_owner_lifecycle_status_idx" ON "capsules" ("owner_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "ssh_branch_access_state_idx" ON "ssh_branch_access" ("state");--> statement-breakpoint
CREATE INDEX "ssh_branch_grants_key_owner_idx" ON "ssh_branch_grants" ("key_owner_user_id");--> statement-breakpoint
CREATE INDEX "ssh_branch_grants_capsule_owner_idx" ON "ssh_branch_grants" ("capsule_owner_user_id");--> statement-breakpoint
CREATE INDEX "ssh_branch_grants_capsule_idx" ON "ssh_branch_grants" ("capsule_id");--> statement-breakpoint
CREATE INDEX "ssh_branch_grants_branch_idx" ON "ssh_branch_grants" ("branch_id");--> statement-breakpoint
CREATE INDEX "ssh_branch_grants_admin_idx" ON "ssh_branch_grants" ("bound_by_admin_user_id");--> statement-breakpoint
CREATE INDEX "ssh_branch_grants_status_idx" ON "ssh_branch_grants" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_branch_grants_active_key_unique_idx" ON "ssh_branch_grants" ("public_key_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_branch_grants_active_key_branch_unique_idx" ON "ssh_branch_grants" ("public_key_id","branch_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_public_keys_blob_unique_idx" ON "ssh_public_keys" ("public_key_blob");--> statement-breakpoint
CREATE INDEX "ssh_public_keys_owner_status_idx" ON "ssh_public_keys" ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "ssh_public_keys_fingerprint_idx" ON "ssh_public_keys" ("fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_relays_ticket_unique_idx" ON "ssh_relays" ("ticket_id");--> statement-breakpoint
CREATE INDEX "ssh_relays_key_idx" ON "ssh_relays" ("public_key_id");--> statement-breakpoint
CREATE INDEX "ssh_relays_user_idx" ON "ssh_relays" ("user_id");--> statement-breakpoint
CREATE INDEX "ssh_relays_capsule_idx" ON "ssh_relays" ("capsule_id");--> statement-breakpoint
CREATE INDEX "ssh_relays_branch_status_idx" ON "ssh_relays" ("branch_id","status");--> statement-breakpoint
CREATE INDEX "ssh_relays_gateway_status_idx" ON "ssh_relays" ("gateway_instance_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_tickets_hash_unique_idx" ON "ssh_tickets" ("ticket_hash");--> statement-breakpoint
CREATE INDEX "ssh_tickets_key_idx" ON "ssh_tickets" ("public_key_id");--> statement-breakpoint
CREATE INDEX "ssh_tickets_grant_idx" ON "ssh_tickets" ("grant_id");--> statement-breakpoint
CREATE INDEX "ssh_tickets_user_idx" ON "ssh_tickets" ("user_id");--> statement-breakpoint
CREATE INDEX "ssh_tickets_capsule_idx" ON "ssh_tickets" ("capsule_id");--> statement-breakpoint
CREATE INDEX "ssh_tickets_branch_status_idx" ON "ssh_tickets" ("branch_id","status");--> statement-breakpoint
CREATE INDEX "ssh_tickets_status_expiry_idx" ON "ssh_tickets" ("status","expires_at");--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_requested_by_user_id_users_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_artifact_entries" ADD CONSTRAINT "capsule_artifact_entries_mrkPSpdKYhcL_fkey" FOREIGN KEY ("manifest_root_id") REFERENCES "capsule_artifact_manifest_roots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_artifact_manifest_roots" ADD CONSTRAINT "capsule_artifact_manifest_roots_26UCvpd2Xqy4_fkey" FOREIGN KEY ("manifest_id") REFERENCES "capsule_artifact_manifests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_artifact_manifests" ADD CONSTRAINT "capsule_artifact_manifests_BI2edSDiAuzg_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_branch_previews" ADD CONSTRAINT "capsule_branch_previews_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_branch_previews" ADD CONSTRAINT "capsule_branch_previews_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_branch_previews" ADD CONSTRAINT "capsule_branch_previews_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_3Q5TCQ46rOSG_fkey" FOREIGN KEY ("created_by_operation_id") REFERENCES "capsule_operations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_branch_resources" ADD CONSTRAINT "capsule_branch_resources_ltnZH1shcsde_fkey" FOREIGN KEY ("last_operation_id") REFERENCES "capsule_operations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_branches" ADD CONSTRAINT "capsule_branches_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_branches" ADD CONSTRAINT "capsule_branches_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_create_operations" ADD CONSTRAINT "capsule_create_operations_kBDKOqhsMbzu_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_operations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_create_operations" ADD CONSTRAINT "capsule_create_operations_GXQTF2XIoGx4_fkey" FOREIGN KEY ("root_branch_id") REFERENCES "capsule_branches"("id");--> statement-breakpoint
ALTER TABLE "capsule_fork_operations" ADD CONSTRAINT "capsule_fork_operations_operation_id_capsule_operations_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_operations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_fork_operations" ADD CONSTRAINT "capsule_fork_operations_iK4qCJ0SYYhG_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_fork_operations" ADD CONSTRAINT "capsule_fork_operations_tBkJl4feiIQn_fkey" FOREIGN KEY ("target_branch_id") REFERENCES "capsule_branches"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_operation_steps" ADD CONSTRAINT "capsule_operation_steps_operation_id_capsule_operations_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_operations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operation_steps" ADD CONSTRAINT "capsule_operation_steps_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operation_steps" ADD CONSTRAINT "capsule_operation_steps_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operation_steps" ADD CONSTRAINT "capsule_operation_steps_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "capsule_operations" ADD CONSTRAINT "capsule_operations_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_operations" ADD CONSTRAINT "capsule_operations_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_route_aliases" ADD CONSTRAINT "capsule_route_aliases_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_route_aliases" ADD CONSTRAINT "capsule_route_aliases_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_route_aliases" ADD CONSTRAINT "capsule_route_aliases_fyS6hPCSNuOJ_fkey" FOREIGN KEY ("mutation_operation_id") REFERENCES "capsule_operations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_aliases" ADD CONSTRAINT "capsule_route_aliases_7kwKsI1rP4QY_fkey" FOREIGN KEY ("last_operation_id") REFERENCES "capsule_operations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_heads" ADD CONSTRAINT "capsule_route_heads_alias_id_capsule_route_aliases_id_fkey" FOREIGN KEY ("alias_id") REFERENCES "capsule_route_aliases"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_route_heads" ADD CONSTRAINT "capsule_route_heads_revision_id_capsule_route_revisions_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "capsule_route_revisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_heads" ADD CONSTRAINT "capsule_route_heads_alias_revision_fk" FOREIGN KEY ("alias_id","revision_id") REFERENCES "capsule_route_revisions"("alias_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_operations" ADD CONSTRAINT "capsule_route_operations_9Oxsk9xju00z_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_operations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_operations" ADD CONSTRAINT "capsule_route_operations_alias_id_capsule_route_aliases_id_fkey" FOREIGN KEY ("alias_id") REFERENCES "capsule_route_aliases"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_operations" ADD CONSTRAINT "capsule_route_operations_LcBdpDr392o6_fkey" FOREIGN KEY ("expected_revision_id") REFERENCES "capsule_route_revisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_operations" ADD CONSTRAINT "capsule_route_operations_Q5HQ6XOxXE6I_fkey" FOREIGN KEY ("proposed_revision_id") REFERENCES "capsule_route_revisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_operations" ADD CONSTRAINT "capsule_route_operations_azbbMXY95gEm_fkey" FOREIGN KEY ("rollback_source_revision_id") REFERENCES "capsule_route_revisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_operations" ADD CONSTRAINT "capsule_route_operations_proposed_alias_revision_fk" FOREIGN KEY ("alias_id","proposed_revision_id") REFERENCES "capsule_route_revisions"("alias_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_operations" ADD CONSTRAINT "capsule_route_operations_expected_alias_revision_fk" FOREIGN KEY ("alias_id","expected_revision_id") REFERENCES "capsule_route_revisions"("alias_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_operations" ADD CONSTRAINT "capsule_route_operations_rollback_alias_revision_fk" FOREIGN KEY ("alias_id","rollback_source_revision_id") REFERENCES "capsule_route_revisions"("alias_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_operations" ADD CONSTRAINT "capsule_route_operations_proposed_operation_revision_fk" FOREIGN KEY ("operation_id","proposed_revision_id") REFERENCES "capsule_route_revisions"("operation_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_provider_applications" ADD CONSTRAINT "capsule_route_provider_applications_ZwmLXpFKereA_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_operations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_provider_applications" ADD CONSTRAINT "capsule_route_provider_applications_UL4MoqtxiI6y_fkey" FOREIGN KEY ("revision_id") REFERENCES "capsule_route_revisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_provider_applications" ADD CONSTRAINT "capsule_route_provider_applications_operation_revision_fk" FOREIGN KEY ("operation_id","revision_id") REFERENCES "capsule_route_revisions"("operation_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_revisions" ADD CONSTRAINT "capsule_route_revisions_alias_id_capsule_route_aliases_id_fkey" FOREIGN KEY ("alias_id") REFERENCES "capsule_route_aliases"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_route_revisions" ADD CONSTRAINT "capsule_route_revisions_snapshot_id_capsule_snapshots_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_revisions" ADD CONSTRAINT "capsule_route_revisions_operation_id_capsule_operations_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_operations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_revisions" ADD CONSTRAINT "capsule_route_revisions_previous_fk" FOREIGN KEY ("alias_id","previous_revision_id") REFERENCES "capsule_route_revisions"("alias_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_route_revisions" ADD CONSTRAINT "capsule_route_revisions_rollback_source_fk" FOREIGN KEY ("alias_id","rollback_source_revision_id") REFERENCES "capsule_route_revisions"("alias_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_capture_operations" ADD CONSTRAINT "capsule_snapshot_capture_operations_ZhOFScnh8rYr_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_operations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_capture_operations" ADD CONSTRAINT "capsule_snapshot_capture_operations_TxTm0hyZaclE_fkey" FOREIGN KEY ("source_branch_id") REFERENCES "capsule_branches"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_capture_operations" ADD CONSTRAINT "capsule_snapshot_capture_operations_viOaGFWNjtRH_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_capture_resources" ADD CONSTRAINT "capsule_snapshot_capture_resources_8G60CcaTLsYo_fkey" FOREIGN KEY ("operation_id") REFERENCES "capsule_snapshot_capture_operations"("operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_capture_resources" ADD CONSTRAINT "capsule_snapshot_capture_resources_Cg5eIMfKn6vE_fkey" FOREIGN KEY ("source_branch_resource_id") REFERENCES "capsule_branch_resources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_dependency_references" ADD CONSTRAINT "capsule_snapshot_dependency_references_JzcghoDeWZIG_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_dependency_references" ADD CONSTRAINT "capsule_snapshot_dependency_references_zgkzWtHStDXh_fkey" FOREIGN KEY ("manifest_root_id") REFERENCES "capsule_artifact_manifest_roots"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_dependency_references" ADD CONSTRAINT "capsule_snapshot_dependency_references_aKRwtCdXJbzq_fkey" FOREIGN KEY ("source_branch_resource_id") REFERENCES "capsule_branch_resources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_git_remotes" ADD CONSTRAINT "capsule_snapshot_git_remotes_tuKeDYvSPPpJ_fkey" FOREIGN KEY ("repository_id") REFERENCES "capsule_snapshot_git_repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_git_repositories" ADD CONSTRAINT "capsule_snapshot_git_repositories_ppYUfc0poN0t_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_git_repositories" ADD CONSTRAINT "capsule_snapshot_git_repositories_y4eaRIq0PmAu_fkey" FOREIGN KEY ("manifest_root_id") REFERENCES "capsule_artifact_manifest_roots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_resource_references" ADD CONSTRAINT "capsule_snapshot_resource_references_7Dfg2YH3xUvN_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "capsule_snapshots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_resource_references" ADD CONSTRAINT "capsule_snapshot_resource_references_MDC6AllcSgX2_fkey" FOREIGN KEY ("manifest_root_id") REFERENCES "capsule_artifact_manifest_roots"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_resource_references" ADD CONSTRAINT "capsule_snapshot_resource_references_0qmkREWAnNs9_fkey" FOREIGN KEY ("source_branch_resource_id") REFERENCES "capsule_branch_resources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshot_resource_references" ADD CONSTRAINT "capsule_snapshot_resource_references_6AL6rcbOW5ak_fkey" FOREIGN KEY ("capture_resource_id") REFERENCES "capsule_snapshot_capture_resources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshots" ADD CONSTRAINT "capsule_snapshots_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsule_snapshots" ADD CONSTRAINT "capsule_snapshots_source_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("source_branch_id") REFERENCES "capsule_branches"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capsules" ADD CONSTRAINT "capsules_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ssh_branch_access" ADD CONSTRAINT "ssh_branch_access_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_branch_grants" ADD CONSTRAINT "ssh_branch_grants_public_key_id_ssh_public_keys_id_fkey" FOREIGN KEY ("public_key_id") REFERENCES "ssh_public_keys"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_branch_grants" ADD CONSTRAINT "ssh_branch_grants_key_owner_user_id_users_id_fkey" FOREIGN KEY ("key_owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_branch_grants" ADD CONSTRAINT "ssh_branch_grants_capsule_owner_user_id_users_id_fkey" FOREIGN KEY ("capsule_owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_branch_grants" ADD CONSTRAINT "ssh_branch_grants_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_branch_grants" ADD CONSTRAINT "ssh_branch_grants_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_branch_grants" ADD CONSTRAINT "ssh_branch_grants_bound_by_admin_user_id_users_id_fkey" FOREIGN KEY ("bound_by_admin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_branch_grants" ADD CONSTRAINT "ssh_branch_grants_revoked_by_user_id_users_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_public_keys" ADD CONSTRAINT "ssh_public_keys_owner_user_id_users_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_relays" ADD CONSTRAINT "ssh_relays_ticket_id_ssh_tickets_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ssh_tickets"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_relays" ADD CONSTRAINT "ssh_relays_public_key_id_ssh_public_keys_id_fkey" FOREIGN KEY ("public_key_id") REFERENCES "ssh_public_keys"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_relays" ADD CONSTRAINT "ssh_relays_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_relays" ADD CONSTRAINT "ssh_relays_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_relays" ADD CONSTRAINT "ssh_relays_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_tickets" ADD CONSTRAINT "ssh_tickets_public_key_id_ssh_public_keys_id_fkey" FOREIGN KEY ("public_key_id") REFERENCES "ssh_public_keys"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_tickets" ADD CONSTRAINT "ssh_tickets_grant_id_ssh_branch_grants_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "ssh_branch_grants"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_tickets" ADD CONSTRAINT "ssh_tickets_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_tickets" ADD CONSTRAINT "ssh_tickets_capsule_id_capsules_id_fkey" FOREIGN KEY ("capsule_id") REFERENCES "capsules"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ssh_tickets" ADD CONSTRAINT "ssh_tickets_branch_id_capsule_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "capsule_branches"("id") ON DELETE RESTRICT;