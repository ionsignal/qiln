import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, pgEnum, index, uniqueIndex, jsonb, type PgColumn } from 'drizzle-orm/pg-core'
import { CapsuleBranchOperationStepStatusValues } from '../../schemas'
import { capsuleBranchesTable } from './branch'
import { capsuleBranchOperationsTable } from './branchOperation'

export const capsuleBranchOperationStepStatusEnum = pgEnum('capsule_branch_operation_step_status', CapsuleBranchOperationStepStatusValues)

function createOwnerIdColumn(ownerIdColumn?: PgColumn) {
  return ownerIdColumn
    ? uuid('owner_id')
        .notNull()
        .references(() => ownerIdColumn, { onDelete: 'cascade' })
    : uuid('owner_id').notNull()
}

function createOperationIdColumn(operationIdColumn?: PgColumn) {
  return operationIdColumn
    ? uuid('operation_id')
        .notNull()
        .references(() => operationIdColumn, { onDelete: 'cascade' })
    : uuid('operation_id').notNull()
}

function createNullableBranchIdColumn(branchIdColumn?: PgColumn) {
  return branchIdColumn
    ? uuid('branch_id').references(() => branchIdColumn, {
        onDelete: 'set null',
      })
    : uuid('branch_id')
}

/**
 * Durable step state for inline capsule branch operations.
 *
 * Step rows are inspection and accounting records for deterministic inline
 * mutation phases. They are not a queue, scheduler, lease, or resume mechanism.
 */
export function createCapsuleBranchOperationStepsTable(ownerIdColumn?: PgColumn, operationIdColumn?: PgColumn, branchIdColumn?: PgColumn) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const operationId = createOperationIdColumn(operationIdColumn)
  const branchId = createNullableBranchIdColumn(branchIdColumn)
  return pgTable(
    'capsule_branch_operation_steps',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      operationId,
      ownerId,
      branchId,
      branchName: text('branch_name').notNull(),
      stepKey: text('step_key').notNull(),
      status: capsuleBranchOperationStepStatusEnum('status').notNull().default('pending'),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
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
      index('capsule_branch_operation_steps_operation_idx').on(table.operationId),
      index('capsule_branch_operation_steps_owner_status_idx').on(table.ownerId, table.status),
      index('capsule_branch_operation_steps_branch_idx').on(table.branchId),
      uniqueIndex('capsule_branch_operation_steps_operation_key_unique_idx').on(table.operationId, table.stepKey),
    ],
  )
}

export const capsuleBranchOperationStepsTable = createCapsuleBranchOperationStepsTable(
  undefined,
  capsuleBranchOperationsTable.id,
  capsuleBranchesTable.id,
)
