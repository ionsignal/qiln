import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, pgEnum, index, uniqueIndex, integer, jsonb, type PgColumn } from 'drizzle-orm/pg-core'
import {
  CapsuleOperationCleanupPolicyValues,
  CapsuleOperationResourceStatusValues,
  CapsuleOperationResourceTypeValues,
  CapsuleOperationStatusValues,
  CapsuleOperationTypeValues,
  type CapsuleBlueprint,
} from '../../schemas'

export const capsuleOperationTypeEnum = pgEnum('capsule_operation_type', CapsuleOperationTypeValues)
export const capsuleOperationStatusEnum = pgEnum('capsule_operation_status', CapsuleOperationStatusValues)
export const capsuleOperationResourceTypeEnum = pgEnum('capsule_operation_resource_type', CapsuleOperationResourceTypeValues)
export const capsuleOperationResourceStatusEnum = pgEnum('capsule_operation_resource_status', CapsuleOperationResourceStatusValues)
export const capsuleOperationCleanupPolicyEnum = pgEnum('capsule_operation_cleanup_policy', CapsuleOperationCleanupPolicyValues)

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

function createOperationIdColumn(operationIdColumn?: PgColumn) {
  return operationIdColumn
    ? uuid('operation_id')
        .notNull()
        .references(() => operationIdColumn, { onDelete: 'cascade' })
    : uuid('operation_id').notNull()
}

/**
 * Durable capsule mutation operation table.
 *
 * The table intentionally models the operation independently from the branch row
 * so retries, crash recovery, and future mutation types can be reasoned about
 * without overloading `capsule_branches.status`.
 */
export function createCapsuleOperationsTable(ownerIdColumn?: PgColumn, branchIdColumn?: PgColumn) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const branchId = createNullableBranchIdColumn(branchIdColumn)

  return pgTable(
    'capsule_operations',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      type: capsuleOperationTypeEnum('type').notNull(),
      status: capsuleOperationStatusEnum('status').notNull().default('accepted'),
      idempotencyKey: uuid('idempotency_key').notNull(),
      requestHash: text('request_hash').notNull(),
      branchId,
      branchName: text('branch_name').notNull(),
      blueprintName: text('blueprint_name').notNull(),
      blueprintDigest: text('blueprint_digest').notNull(),
      blueprintSnapshot: jsonb('blueprint_snapshot').$type<CapsuleBlueprint>().notNull(),
      leaseOwner: text('lease_owner'),
      leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
      attemptCount: integer('attempt_count').notNull().default(0),
      startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
      completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
      failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
      failureCode: text('failure_code'),
      failureMessage: text('failure_message'),
      failureDetails: jsonb('failure_details').$type<Record<string, unknown>>(),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    table => [
      index('capsule_operations_owner_status_idx').on(table.ownerId, table.status),
      index('capsule_operations_branch_idx').on(table.branchId),
      index('capsule_operations_lease_idx').on(table.status, table.leaseExpiresAt),
      uniqueIndex('capsule_operations_owner_idempotency_key_unique_idx').on(table.ownerId, table.idempotencyKey),
    ],
  )
}

/**
 * Durable ledger of external resources touched by a capsule operation.
 *
 * Full crash recovery is a later phase, but this ledger gives that recovery code
 * a durable source of truth instead of reconstructing intent from branch names.
 */
export function createCapsuleOperationResourcesTable(ownerIdColumn?: PgColumn, operationIdColumn?: PgColumn, branchIdColumn?: PgColumn) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const operationId = createOperationIdColumn(operationIdColumn)
  const branchId = createNullableBranchIdColumn(branchIdColumn)

  return pgTable(
    'capsule_operation_resources',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      operationId,
      ownerId,
      branchId,
      branchName: text('branch_name').notNull(),
      resourceType: capsuleOperationResourceTypeEnum('resource_type').notNull(),
      provider: text('provider').notNull().default('incus'),
      resourceKey: text('resource_key').notNull(),
      status: capsuleOperationResourceStatusEnum('status').notNull().default('planned'),
      cleanupPolicy: capsuleOperationCleanupPolicyEnum('cleanup_policy').notNull(),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    table => [
      index('capsule_operation_resources_operation_idx').on(table.operationId),
      index('capsule_operation_resources_owner_idx').on(table.ownerId),
      index('capsule_operation_resources_branch_idx').on(table.branchId),
      index('capsule_operation_resources_resource_key_idx').on(table.resourceKey),
      uniqueIndex('capsule_operation_resources_operation_key_unique_idx').on(table.operationId, table.resourceKey),
    ],
  )
}
