import { sql } from 'drizzle-orm'
import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { CapsuleOperationStepStatusValues } from '../../../schemas'
import { capsuleBranchesTable } from '../branch/record'
import { capsulesTable } from '../record'
import { capsuleOperationsTable } from './record'

export const capsuleOperationStepStatusEnum = pgEnum('capsule_operation_step_status', CapsuleOperationStepStatusValues)

function createOwnerIdColumn(ownerIdColumn?: PgColumn) {
  return ownerIdColumn
    ? uuid('owner_id')
        .notNull()
        .references(() => ownerIdColumn, { onDelete: 'cascade' })
    : uuid('owner_id').notNull()
}

function createCapsuleIdColumn(capsuleIdColumn?: PgColumn) {
  return capsuleIdColumn
    ? uuid('capsule_id')
        .notNull()
        .references(() => capsuleIdColumn, { onDelete: 'cascade' })
    : uuid('capsule_id').notNull()
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
 * Durable accounting state for inline capsule operation steps.
 *
 * Step rows provide inspection visibility only. They are not queue jobs,
 * resumable checkpoints, leases, retries, or scheduler stages.
 */
export function createCapsuleOperationStepsTable(
  ownerIdColumn?: PgColumn,
  capsuleIdColumn?: PgColumn,
  operationIdColumn?: PgColumn,
  branchIdColumn?: PgColumn,
) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const capsuleId = createCapsuleIdColumn(capsuleIdColumn)
  const operationId = createOperationIdColumn(operationIdColumn)
  const branchId = createNullableBranchIdColumn(branchIdColumn)
  return pgTable(
    'capsule_operation_steps',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      operationId,
      capsuleId,
      ownerId,
      branchId,
      branchName: text('branch_name'),
      stepKey: text('step_key').notNull(),
      status: capsuleOperationStepStatusEnum('status').notNull().default('pending'),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
      startedAt: timestamp('started_at', {
        withTimezone: true,
        mode: 'date',
      }),
      completedAt: timestamp('completed_at', {
        withTimezone: true,
        mode: 'date',
      }),
      failedAt: timestamp('failed_at', {
        withTimezone: true,
        mode: 'date',
      }),
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
      index('capsule_operation_steps_operation_idx').on(table.operationId),
      index('capsule_operation_steps_capsule_idx').on(table.capsuleId),
      index('capsule_operation_steps_owner_status_idx').on(table.ownerId, table.status),
      index('capsule_operation_steps_branch_idx').on(table.branchId),
      uniqueIndex('capsule_operation_steps_operation_key_unique_idx').on(table.operationId, table.stepKey),
    ],
  )
}

export const capsuleOperationStepsTable = createCapsuleOperationStepsTable(
  undefined,
  capsulesTable.id,
  capsuleOperationsTable.id,
  capsuleBranchesTable.id,
)
