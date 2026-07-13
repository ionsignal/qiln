import { sql } from 'drizzle-orm'
import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { CapsuleLifecycleOperationStatusValues, CapsuleLifecycleOperationTypeValues, type CapsuleBlueprint } from '../../schemas'
import { capsuleBranchesTable } from './branch'
import { capsulesTable } from './capsule'

export const capsuleLifecycleOperationTypeEnum = pgEnum('capsule_lifecycle_operation_type', CapsuleLifecycleOperationTypeValues)
export const capsuleLifecycleOperationStatusEnum = pgEnum('capsule_lifecycle_operation_status', CapsuleLifecycleOperationStatusValues)

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

function createNullableBranchIdColumn(branchIdColumn?: PgColumn) {
  return branchIdColumn
    ? uuid('branch_id').references(() => branchIdColumn, {
        onDelete: 'set null',
      })
    : uuid('branch_id')
}

/**
 * Durable capsule lifecycle operation table.
 *
 * Bootstrap has one root branch subject and stores reviewed blueprint provenance. Archive, unarchive,
 * and destroy are capsule-wide and therefore leave branch identity and bootstrap provenance null.
 */
export function createCapsuleLifecycleOperationsTable(ownerIdColumn?: PgColumn, capsuleIdColumn?: PgColumn, branchIdColumn?: PgColumn) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const capsuleId = createCapsuleIdColumn(capsuleIdColumn)
  const branchId = createNullableBranchIdColumn(branchIdColumn)
  return pgTable(
    'capsule_lifecycle_operations',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      capsuleId,
      branchId,
      type: capsuleLifecycleOperationTypeEnum('type').notNull(),
      status: capsuleLifecycleOperationStatusEnum('status').notNull().default('accepted'),
      idempotencyKey: uuid('idempotency_key').notNull(),
      requestHash: text('request_hash').notNull(),
      branchName: text('branch_name'),
      blueprintName: text('blueprint_name'),
      blueprintDigest: text('blueprint_digest'),
      blueprintSnapshot: jsonb('blueprint_snapshot').$type<CapsuleBlueprint>(),
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
      index('capsule_lifecycle_operations_owner_status_idx').on(table.ownerId, table.status),
      index('capsule_lifecycle_operations_capsule_status_idx').on(table.capsuleId, table.status),
      index('capsule_lifecycle_operations_branch_idx').on(table.branchId),
      uniqueIndex('capsule_lifecycle_operations_owner_idempotency_key_unique_idx').on(table.ownerId, table.idempotencyKey),
    ],
  )
}

export const capsuleLifecycleOperationsTable = createCapsuleLifecycleOperationsTable(undefined, capsulesTable.id, capsuleBranchesTable.id)
