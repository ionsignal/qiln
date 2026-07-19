import { sql } from 'drizzle-orm'
import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { CapsuleActorTypeValues, CapsuleOperationStatusValues, CapsuleOperationTypeValues, type CapsuleBlueprint } from '../../schemas'
import { capsuleBranchesTable } from './branch'
import { capsulesTable } from './capsule'

export const capsuleActorTypeEnum = pgEnum('capsule_actor_type', CapsuleActorTypeValues)
export const capsuleOperationTypeEnum = pgEnum('capsule_operation_type', CapsuleOperationTypeValues)
export const capsuleOperationStatusEnum = pgEnum('capsule_operation_status', CapsuleOperationStatusValues)

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
 * Durable control-plane operation ledger.
 *
 * Acceptance precedes execution. `providerMutationStartedAt` is the operation
 * fence written before the first provider mutation, allowing a restarted Worker
 * to distinguish safe pre-provider failure from provider-state uncertainty.
 *
 * Actor provenance is immutable acceptance-time evidence. Actor IDs are
 * polymorphic references rather than foreign keys so audit history survives
 * principal retirement.
 */
export function createCapsuleOperationsTable(ownerIdColumn?: PgColumn, capsuleIdColumn?: PgColumn, branchIdColumn?: PgColumn) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const capsuleId = createCapsuleIdColumn(capsuleIdColumn)
  const branchId = createNullableBranchIdColumn(branchIdColumn)

  return pgTable(
    'capsule_operations',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      actorType: capsuleActorTypeEnum('actor_type').notNull(),
      actorId: uuid('actor_id').notNull(),
      capsuleId,
      branchId,
      type: capsuleOperationTypeEnum('type').notNull(),
      status: capsuleOperationStatusEnum('status').notNull().default('accepted'),
      idempotencyKey: uuid('idempotency_key').notNull(),
      requestHash: text('request_hash').notNull(),
      branchName: text('branch_name'),
      blueprintName: text('blueprint_name'),
      blueprintDigest: text('blueprint_digest'),
      blueprintSnapshot: jsonb('blueprint_snapshot').$type<CapsuleBlueprint>(),
      acceptedAt: timestamp('accepted_at', {
        withTimezone: true,
        mode: 'date',
      })
        .notNull()
        .defaultNow(),
      executionStartedAt: timestamp('execution_started_at', {
        withTimezone: true,
        mode: 'date',
      }),
      providerMutationStartedAt: timestamp('provider_mutation_started_at', {
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
      index('capsule_operations_owner_status_idx').on(table.ownerId, table.status),
      index('capsule_operations_actor_idx').on(table.actorType, table.actorId),
      index('capsule_operations_capsule_status_idx').on(table.capsuleId, table.status),
      index('capsule_operations_branch_idx').on(table.branchId),
      index('capsule_operations_provider_mutation_started_idx').on(table.providerMutationStartedAt),
      uniqueIndex('capsule_operations_owner_idempotency_key_unique_idx').on(table.ownerId, table.idempotencyKey),
      uniqueIndex('capsule_operations_capsule_nonterminal_unique_idx')
        .on(table.capsuleId)
        .where(sql`${table.status} IN ('accepted', 'running')`),
    ],
  )
}

export const capsuleOperationsTable = createCapsuleOperationsTable(undefined, capsulesTable.id, capsuleBranchesTable.id)
