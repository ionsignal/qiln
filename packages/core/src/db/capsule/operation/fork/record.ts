import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import type {
  CapsuleBlueprintDigest,
  CapsuleBlueprintPin,
  CapsuleBranchName,
  CapsuleBranchResourceInventoryDigest,
  CapsuleRootfsImagePin,
} from '../../../../schemas'

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
 * Immutable fork-operation input and provisional target branch reference.
 *
 * The committed source snapshot, historical Blueprint, exact rootfs image,
 * requested sizing, and complete target inventory proof are accepted before
 * provider execution. Managed storage may be cloned only through the source
 * snapshot's exact committed provider references.
 *
 * Bind mounts are reattached from historical Blueprint configuration without
 * claiming their current contents match the source branch's earlier contents.
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
      cpu: text('cpu').notNull(),
      memory: text('memory').notNull(),
    },
    table => [
      index('capsule_fork_operations_source_snapshot_idx').on(table.sourceSnapshotId),
      index('capsule_fork_operations_blueprint_digest_idx').on(table.blueprintDigest),
      uniqueIndex('capsule_fork_operations_target_branch_unique_idx').on(table.targetBranchId),
      check('capsule_fork_operations_blueprint_schema_check', sql`${table.blueprintSchemaVersion} = 1`),
      check('capsule_fork_operations_blueprint_digest_check', sql`${table.blueprintDigest} ~ '^sha256:[a-f0-9]{64}$'`),
      check(
        'capsule_fork_operations_inventory_digest_check',
        sql`${table.targetBranchResourceInventoryDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
    ],
  )
}
