import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import type {
  CapsuleBranchName,
  CapsuleBranchResourceInventoryDigest,
  CapsuleSnapshotCapturePolicyDigest,
  CapsuleSnapshotCapturePolicyPin,
} from '../../../../schemas'
import { capsuleSnapshotModeEnum } from '../../snapshot/record'

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
 * Creates the Snapshot Capture operation extension.
 *
 * The extension owns immutable acceptance-time source-branch, capture-policy,
 * and requested-mode evidence. `snapshotId` remains null until the atomic
 * capture commit transaction links this operation to committed snapshot
 * history.
 *
 * PostgreSQL cannot prove that the referenced base operation has the
 * `snapshot_capture` discriminator. Every repository path that uses this
 * extension as mutation or read authority must validate the base operation
 * type.
 */
export function createCapsuleSnapshotCaptureOperationsTable(
  operationIdColumn?: PgColumn,
  sourceBranchIdColumn?: PgColumn,
  snapshotIdColumn?: PgColumn,
) {
  const operationId = createOperationIdColumn(operationIdColumn)
  const sourceBranchId = createSourceBranchIdColumn(sourceBranchIdColumn)
  const snapshotId = createNullableSnapshotIdColumn(snapshotIdColumn)

  return pgTable(
    'capsule_snapshot_capture_operations',
    {
      operationId,
      sourceBranchId,
      sourceBranchName: text('source_branch_name').$type<CapsuleBranchName>().notNull(),
      sourceBranchResourceInventoryDigest: text('source_branch_resource_inventory_digest')
        .$type<CapsuleBranchResourceInventoryDigest>()
        .notNull(),
      capturePolicySchemaVersion: integer('capture_policy_schema_version').notNull(),
      capturePolicyDigest: text('capture_policy_digest').$type<CapsuleSnapshotCapturePolicyDigest>().notNull(),
      capturePolicyPin: jsonb('capture_policy_pin').$type<CapsuleSnapshotCapturePolicyPin>().notNull(),
      requestedMode: capsuleSnapshotModeEnum('requested_mode').notNull().default('experimental'),
      snapshotId,
    },
    table => [
      index('capsule_snapshot_capture_operations_source_branch_idx').on(table.sourceBranchId),
      index('capsule_snapshot_capture_operations_policy_digest_idx').on(table.capturePolicyDigest),
      index('capsule_snapshot_capture_operations_mode_idx').on(table.requestedMode),
      uniqueIndex('capsule_snapshot_capture_operations_snapshot_unique_idx').on(table.snapshotId),
      check('capsule_snapshot_capture_operations_policy_schema_check', sql`${table.capturePolicySchemaVersion} = 1`),
      check(
        'capsule_snapshot_capture_operations_policy_digest_check',
        sql`${table.capturePolicyDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
      check(
        'capsule_snapshot_capture_operations_inventory_digest_check',
        sql`${table.sourceBranchResourceInventoryDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
    ],
  )
}
