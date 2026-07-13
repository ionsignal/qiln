import { sql } from 'drizzle-orm'
import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { CapsuleBranchResourceCleanupPolicyValues, CapsuleBranchResourceStatusValues, CapsuleBranchResourceTypeValues } from '../../schemas'
import { capsuleBranchesTable } from './branch'
import { capsuleLifecycleOperationsTable } from './lifecycleOperation'

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

function createNullableLifecycleOperationIdColumn(columnName: string, operationIdColumn?: PgColumn) {
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
 * Lifecycle operation provenance records which operation created and last
 * touched a resource. Destroy can delete only resources whose durable inventory,
 * cleanup policy, and provider state satisfy its fail-closed ownership checks.
 */
export function createCapsuleBranchResourcesTable(ownerIdColumn?: PgColumn, branchIdColumn?: PgColumn, lifecycleOperationIdColumn?: PgColumn) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const branchId = createNullableBranchIdColumn(branchIdColumn)
  const lastLifecycleOperationId = createNullableLifecycleOperationIdColumn('last_lifecycle_operation_id', lifecycleOperationIdColumn)
  const createdByLifecycleOperationId = createNullableLifecycleOperationIdColumn(
    'created_by_lifecycle_operation_id',
    lifecycleOperationIdColumn,
  )
  return pgTable(
    'capsule_branch_resources',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      branchId,
      branchName: text('branch_name').notNull(),
      createdByLifecycleOperationId,
      lastLifecycleOperationId,
      resourceType: capsuleBranchResourceTypeEnum('resource_type').notNull(),
      provider: text('provider').notNull().default('incus'),
      resourceKey: text('resource_key').notNull(),
      status: capsuleBranchResourceStatusEnum('status').notNull().default('planned'),
      cleanupPolicy: capsuleBranchResourceCleanupPolicyEnum('cleanup_policy').notNull(),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
      failureCode: text('failure_code'),
      failureMessage: text('failure_message'),
      failureDetails: jsonb('failure_details').$type<Record<string, unknown>>(),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'date',
      })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp('updated_at', {
        withTimezone: true,
        mode: 'date',
      })
        .notNull()
        .defaultNow(),
    },
    table => [
      index('capsule_branch_resources_owner_idx').on(table.ownerId),
      index('capsule_branch_resources_branch_idx').on(table.branchId),
      index('capsule_branch_resources_created_by_lifecycle_operation_idx').on(table.createdByLifecycleOperationId),
      index('capsule_branch_resources_last_lifecycle_operation_idx').on(table.lastLifecycleOperationId),
      index('capsule_branch_resources_resource_key_idx').on(table.resourceKey),
      uniqueIndex('capsule_branch_resources_lifecycle_operation_key_unique_idx').on(table.createdByLifecycleOperationId, table.resourceKey),
      uniqueIndex('capsule_branch_resources_branch_key_unique_idx').on(table.branchId, table.resourceKey),
    ],
  )
}

export const capsuleBranchResourcesTable = createCapsuleBranchResourcesTable(
  undefined,
  capsuleBranchesTable.id,
  capsuleLifecycleOperationsTable.id,
)
