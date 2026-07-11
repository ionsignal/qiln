import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, pgEnum, index, uniqueIndex, jsonb, type PgColumn } from 'drizzle-orm/pg-core'
import { CapsuleBranchResourceCleanupPolicyValues, CapsuleBranchResourceStatusValues, CapsuleBranchResourceTypeValues } from '../../schemas'
import { capsuleBranchesTable } from './branch'
import { capsuleBranchOperationsTable } from './branchOperation'

export const capsuleBranchResourceTypeEnum = pgEnum('capsule_branch_resource_type', CapsuleBranchResourceTypeValues)
export const capsuleBranchResourceStatusEnum = pgEnum('capsule_branch_resource_status', CapsuleBranchResourceStatusValues)
export const capsuleBranchResourceCleanupPolicyEnum = pgEnum('capsule_branch_resource_cleanup_policy', CapsuleBranchResourceCleanupPolicyValues)

function createOwnerIdColumn(ownerIdColumn?: PgColumn) {
  return ownerIdColumn
    ? uuid('owner_id')
        .notNull()
        .references(() => ownerIdColumn, { onDelete: 'cascade' })
    : uuid('owner_id').notNull()
}

function createNullableBranchIdColumn(branchIdColumn?: PgColumn) {
  return branchIdColumn
    ? uuid('branch_id').references(() => branchIdColumn, {
        onDelete: 'set null',
      })
    : uuid('branch_id')
}

function createNullableOperationIdColumn(columnName: string, operationIdColumn?: PgColumn) {
  const column = uuid(columnName)
  return operationIdColumn
    ? column.references(() => operationIdColumn, {
        onDelete: 'set null',
      })
    : column
}

/**
 * Durable branch resource inventory.
 *
 * Each row records a resource Qiln planned, adopted, created, or deleted while
 * mutating a capsule branch. The worker uses this inventory as the authoritative
 * ownership proof for fail-closed deletion and cleanup accounting.
 */
export function createCapsuleBranchResourcesTable(ownerIdColumn?: PgColumn, branchIdColumn?: PgColumn, operationIdColumn?: PgColumn) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const branchId = createNullableBranchIdColumn(branchIdColumn)
  const createdByOperationId = createNullableOperationIdColumn('created_by_operation_id', operationIdColumn)
  const lastOperationId = createNullableOperationIdColumn('last_operation_id', operationIdColumn)
  return pgTable(
    'capsule_branch_resources',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      branchId,
      branchName: text('branch_name').notNull(),
      createdByOperationId,
      lastOperationId,
      resourceType: capsuleBranchResourceTypeEnum('resource_type').notNull(),
      provider: text('provider').notNull().default('incus'),
      resourceKey: text('resource_key').notNull(),
      status: capsuleBranchResourceStatusEnum('status').notNull().default('planned'),
      cleanupPolicy: capsuleBranchResourceCleanupPolicyEnum('cleanup_policy').notNull(),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
      failureCode: text('failure_code'),
      failureMessage: text('failure_message'),
      failureDetails: jsonb('failure_details').$type<Record<string, unknown>>(),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    table => [
      index('capsule_branch_resources_owner_idx').on(table.ownerId),
      index('capsule_branch_resources_branch_idx').on(table.branchId),
      index('capsule_branch_resources_created_by_operation_idx').on(table.createdByOperationId),
      index('capsule_branch_resources_last_operation_idx').on(table.lastOperationId),
      index('capsule_branch_resources_resource_key_idx').on(table.resourceKey),
      uniqueIndex('capsule_branch_resources_operation_key_unique_idx').on(table.createdByOperationId, table.resourceKey),
      uniqueIndex('capsule_branch_resources_branch_key_unique_idx').on(table.branchId, table.resourceKey),
    ],
  )
}

export const capsuleBranchResourcesTable = createCapsuleBranchResourcesTable(
  undefined,
  capsuleBranchesTable.id,
  capsuleBranchOperationsTable.id,
)
