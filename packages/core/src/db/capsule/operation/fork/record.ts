import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import type {
  CapsuleBlueprintDigest,
  CapsuleBlueprintPin,
  CapsuleBranchName,
  CapsuleBranchResourceInventoryDigest,
  CapsuleRootfsImagePin,
  CapsuleSnapshotCapturePolicyDigest,
  CapsuleSnapshotCapturePolicyPin,
  CapsuleSnapshotLimitationValue,
} from '../../../../schemas'
import { capsuleSnapshotModeEnum } from '../../snapshot/record'

function createOperationIdColumn(operationIdColumn?: PgColumn) {
  return operationIdColumn
    ? uuid('operation_id')
        .primaryKey()
        .references(() => operationIdColumn, { onDelete: 'restrict' })
    : uuid('operation_id').primaryKey()
}

function createSnapshotIdColumn(snapshotIdColumn?: PgColumn) {
  return snapshotIdColumn
    ? uuid('source_snapshot_id')
        .notNull()
        .references(() => snapshotIdColumn, { onDelete: 'restrict' })
    : uuid('source_snapshot_id').notNull()
}

function createBranchIdColumn(branchIdColumn?: PgColumn) {
  return branchIdColumn
    ? uuid('target_branch_id')
        .notNull()
        .references(() => branchIdColumn, { onDelete: 'restrict' })
    : uuid('target_branch_id').notNull()
}

/**
 * Creates immutable fork-operation input and its provisional target branch
 * reference.
 *
 * The source snapshot, historical Blueprint, rootfs image, capture policy,
 * assurance, requested branch sizing, and complete target resource-inventory
 * digest are accepted before provider execution. Fork execution must reload
 * this evidence from PostgreSQL and may clone storage only through the source
 * snapshot's committed provider references.
 *
 * PostgreSQL cannot prove that the referenced base operation has the `fork`
 * discriminator. Every fork repository path that uses this extension as
 * mutation, replay, completion, or abandonment authority must validate the base
 * operation type.
 */
export function createCapsuleForkOperationsTable(
  operationIdColumn?: PgColumn,
  snapshotIdColumn?: PgColumn,
  branchIdColumn?: PgColumn,
) {
  const operationId = createOperationIdColumn(operationIdColumn)
  const sourceSnapshotId = createSnapshotIdColumn(snapshotIdColumn)
  const targetBranchId = createBranchIdColumn(branchIdColumn)
  return pgTable(
    'capsule_fork_operations',
    {
      operationId,
      sourceSnapshotId,
      targetBranchId,
      targetBranchName: text('target_branch_name').$type<CapsuleBranchName>().notNull(),
      targetBranchResourceInventoryDigest: text('target_branch_resource_inventory_digest')
        .$type<CapsuleBranchResourceInventoryDigest>()
        .notNull(),
      blueprintSchemaVersion: integer('blueprint_schema_version').notNull(),
      blueprintName: text('blueprint_name').notNull(),
      blueprintDigest: text('blueprint_digest').$type<CapsuleBlueprintDigest>().notNull(),
      blueprintPin: jsonb('blueprint_pin').$type<CapsuleBlueprintPin>().notNull(),
      rootfsImagePin: jsonb('rootfs_image_pin').$type<CapsuleRootfsImagePin>().notNull(),
      capturePolicySchemaVersion: integer('capture_policy_schema_version').notNull(),
      capturePolicyDigest: text('capture_policy_digest').$type<CapsuleSnapshotCapturePolicyDigest>().notNull(),
      capturePolicyPin: jsonb('capture_policy_pin').$type<CapsuleSnapshotCapturePolicyPin>().notNull(),
      sourceSnapshotMode: capsuleSnapshotModeEnum('source_snapshot_mode').notNull(),
      sourceSnapshotLimitations: jsonb('source_snapshot_limitations')
        .$type<CapsuleSnapshotLimitationValue[]>()
        .notNull(),
      cpu: text('cpu').notNull(),
      memory: text('memory').notNull(),
    },
    table => [
      index('capsule_fork_operations_source_snapshot_idx').on(table.sourceSnapshotId),
      index('capsule_fork_operations_blueprint_digest_idx').on(table.blueprintDigest),
      index('capsule_fork_operations_policy_digest_idx').on(table.capturePolicyDigest),
      uniqueIndex('capsule_fork_operations_target_branch_unique_idx').on(table.targetBranchId),
      check('capsule_fork_operations_blueprint_schema_check', sql`${table.blueprintSchemaVersion} = 1`),
      check('capsule_fork_operations_blueprint_digest_check', sql`${table.blueprintDigest} ~ '^sha256:[a-f0-9]{64}$'`),
      check('capsule_fork_operations_policy_schema_check', sql`${table.capturePolicySchemaVersion} = 1`),
      check('capsule_fork_operations_policy_digest_check', sql`${table.capturePolicyDigest} ~ '^sha256:[a-f0-9]{64}$'`),
      check(
        'capsule_fork_operations_inventory_digest_check',
        sql`${table.targetBranchResourceInventoryDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
      check(
        'capsule_fork_operations_assurance_check',
        sql`(
          (
            ${table.sourceSnapshotMode} = 'experimental'
            AND jsonb_typeof(${table.sourceSnapshotLimitations}) = 'array'
            AND jsonb_array_length(${table.sourceSnapshotLimitations}) > 0
          )
          OR
          (
            ${table.sourceSnapshotMode} = 'hardened'
            AND jsonb_typeof(${table.sourceSnapshotLimitations}) = 'array'
            AND jsonb_array_length(${table.sourceSnapshotLimitations}) = 0
          )
        )`,
      ),
    ],
  )
}
