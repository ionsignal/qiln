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

function createSourceBranchIdColumn(sourceBranchIdColumn?: PgColumn) {
  return sourceBranchIdColumn
    ? uuid('source_branch_id')
        .notNull()
        .references(() => sourceBranchIdColumn, { onDelete: 'restrict' })
    : uuid('source_branch_id').notNull()
}

function createNullableSnapshotIdColumn(snapshotIdColumn?: PgColumn) {
  return snapshotIdColumn
    ? uuid('snapshot_id').references(() => snapshotIdColumn, {
        onDelete: 'restrict',
      })
    : uuid('snapshot_id')
}

/**
 * Immutable acceptance-time input for one Create Snapshot operation.
 *
 * Historical Blueprint configuration, the exact rootfs image pin, and source
 * branch inventory proof are accepted before provider mutation. `snapshotId`
 * remains null until the atomic commit transaction links complete restoration
 * evidence and completes the base operation.
 *
 * PostgreSQL proves row identity, not the base operation discriminator.
 * Repositories must validate `snapshot_create` whenever this extension
 * authorizes execution, replay, finalization, or abandonment classification.
 */
export function createCapsuleSnapshotCreateOperationsTable(
  operationIdColumn?: PgColumn,
  sourceBranchIdColumn?: PgColumn,
  snapshotIdColumn?: PgColumn,
) {
  const operationId = createOperationIdColumn(operationIdColumn)
  const sourceBranchId = createSourceBranchIdColumn(sourceBranchIdColumn)
  const snapshotId = createNullableSnapshotIdColumn(snapshotIdColumn)
  return pgTable(
    'capsule_snapshot_create_operations',
    {
      operationId,
      sourceBranchId,
      sourceBranchName: text('source_branch_name').$type<CapsuleBranchName>().notNull(),
      sourceBranchResourceInventoryDigest: text('source_branch_resource_inventory_digest')
        .$type<CapsuleBranchResourceInventoryDigest>()
        .notNull(),
      blueprintSchemaVersion: integer('blueprint_schema_version').notNull(),
      blueprintName: text('blueprint_name').notNull(),
      blueprintDigest: text('blueprint_digest').$type<CapsuleBlueprintDigest>().notNull(),
      blueprintPin: jsonb('blueprint_pin').$type<CapsuleBlueprintPin>().notNull(),
      rootfsImagePin: jsonb('rootfs_image_pin').$type<CapsuleRootfsImagePin>().notNull(),
      snapshotId,
    },
    table => [
      index('capsule_snapshot_create_operations_source_branch_idx').on(table.sourceBranchId),
      index('capsule_snapshot_create_operations_blueprint_digest_idx').on(table.blueprintDigest),
      uniqueIndex('capsule_snapshot_create_operations_snapshot_unique_idx').on(table.snapshotId),
      check('capsule_snapshot_create_operations_blueprint_schema_check', sql`${table.blueprintSchemaVersion} = 1`),
      check(
        'capsule_snapshot_create_operations_blueprint_digest_check',
        sql`${table.blueprintDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
      check(
        'capsule_snapshot_create_operations_inventory_digest_check',
        sql`${table.sourceBranchResourceInventoryDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
    ],
  )
}
