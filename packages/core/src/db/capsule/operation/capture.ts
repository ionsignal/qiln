import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import type {
  CapsuleBranchName,
  CapsuleBranchResourceInventoryDigest,
  CapsuleSnapshotCapturePolicyDigest,
  CapsuleSnapshotCapturePolicyPin,
} from '../../../schemas'
import { capsuleBranchesTable } from '../branch/record'
import { capsuleSnapshotsTable } from '../snapshot/record'
import { capsuleOperationsTable } from './record'

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
 * Creates the dormant Snapshot Capture operation extension.
 *
 * This table defines future immutable operation input and committed-result
 * identity only. Phase 1 adds no operation discriminator, command, writer,
 * executor, event, or abandonment policy capable of inserting these rows.
 *
 * PostgreSQL cannot prove that the referenced base operation has the future
 * Snapshot Capture discriminator. The complete operation slice must validate
 * that discriminator whenever this extension authorizes any mutation or read.
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
      snapshotId,
    },
    table => [
      index('capsule_snapshot_capture_operations_source_branch_idx').on(table.sourceBranchId),
      index('capsule_snapshot_capture_operations_policy_digest_idx').on(table.capturePolicyDigest),
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

export const capsuleSnapshotCaptureOperationsTable = createCapsuleSnapshotCaptureOperationsTable(
  capsuleOperationsTable.id,
  capsuleBranchesTable.id,
  capsuleSnapshotsTable.id,
)
