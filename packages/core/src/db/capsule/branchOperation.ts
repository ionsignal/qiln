import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, pgEnum, index, uniqueIndex, jsonb, type PgColumn } from 'drizzle-orm/pg-core'
import { CapsuleBranchOperationStatusValues, CapsuleBranchOperationTypeValues, type CapsuleBlueprint } from '../../schemas'
import { capsuleBranchesTable } from './branch'

export const capsuleBranchOperationTypeEnum = pgEnum('capsule_branch_operation_type', CapsuleBranchOperationTypeValues)
export const capsuleBranchOperationStatusEnum = pgEnum('capsule_branch_operation_status', CapsuleBranchOperationStatusValues)

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

/**
 * Durable branch mutation operation table.
 *
 * Branch create and delete both use this fail-closed ledger. Create-specific blueprint columns are
 * nullable because delete operations should not fabricate blueprint data.
 */
export function createCapsuleBranchOperationsTable(ownerIdColumn?: PgColumn, branchIdColumn?: PgColumn) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const branchId = createNullableBranchIdColumn(branchIdColumn)
  return pgTable(
    'capsule_branch_operations',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      branchId,
      type: capsuleBranchOperationTypeEnum('type').notNull(),
      status: capsuleBranchOperationStatusEnum('status').notNull().default('accepted'),
      idempotencyKey: uuid('idempotency_key').notNull(),
      requestHash: text('request_hash').notNull(),
      branchName: text('branch_name').notNull(),
      blueprintName: text('blueprint_name'),
      blueprintDigest: text('blueprint_digest'),
      blueprintSnapshot: jsonb('blueprint_snapshot').$type<CapsuleBlueprint>(),
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
      index('capsule_branch_operations_owner_status_idx').on(table.ownerId, table.status),
      index('capsule_branch_operations_owner_branch_idx').on(table.ownerId, table.branchName),
      index('capsule_branch_operations_branch_idx').on(table.branchId),
      uniqueIndex('capsule_branch_operations_owner_idempotency_key_unique_idx').on(table.ownerId, table.idempotencyKey),
    ],
  )
}

export const capsuleBranchOperationsTable = createCapsuleBranchOperationsTable(undefined, capsuleBranchesTable.id)
