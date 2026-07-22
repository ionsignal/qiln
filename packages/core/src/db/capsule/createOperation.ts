import { jsonb, pgTable, text, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import type { CapsuleBlueprint, CapsuleBlueprintDigest, CapsuleBranchName } from '../../schemas'
import { capsuleBranchesTable } from './branch'
import { capsuleOperationsTable } from './operation'

function createOperationIdColumn(operationIdColumn?: PgColumn) {
  return operationIdColumn
    ? uuid('operation_id')
        .primaryKey()
        .references(() => operationIdColumn, { onDelete: 'cascade' })
    : uuid('operation_id').primaryKey()
}

function createRootBranchIdColumn(rootBranchIdColumn?: PgColumn) {
  return rootBranchIdColumn
    ? uuid('root_branch_id')
        .notNull()
        .references(() => rootBranchIdColumn)
    : uuid('root_branch_id').notNull()
}

/**
 * Immutable operation-specific input and committed-result references for one
 * capsule create operation.
 *
 * The base `capsule_operations` row owns common mutation-control state such as
 * actor provenance, idempotency, execution fences, and terminal status. This
 * extension owns only create-specific immutable input and the root branch
 * produced by that mutation.
 *
 * The referenced root branch remains the domain object. This row describes the
 * create mutation and must not become an alternate source of mutable branch
 * lifecycle or runtime state.
 *
 * PostgreSQL foreign keys prove row identity but cannot enforce that the
 * referenced base operation has type `create`. Create repositories must verify
 * the operation discriminator whenever this extension authorizes execution,
 * replay, terminalization, or abandonment classification.
 */
export function createCapsuleCreateOperationsTable(operationIdColumn?: PgColumn, rootBranchIdColumn?: PgColumn) {
  const operationId = createOperationIdColumn(operationIdColumn)
  const rootBranchId = createRootBranchIdColumn(rootBranchIdColumn)

  return pgTable(
    'capsule_create_operations',
    {
      operationId,
      rootBranchId,
      rootBranchName: text('root_branch_name').$type<CapsuleBranchName>().notNull(),
      blueprintName: text('blueprint_name').notNull(),
      blueprintDigest: text('blueprint_digest').$type<CapsuleBlueprintDigest>().notNull(),
      blueprintSnapshot: jsonb('blueprint_snapshot').$type<CapsuleBlueprint>().notNull(),
      cpu: text('cpu').notNull(),
      memory: text('memory').notNull(),
    },
    table => [uniqueIndex('capsule_create_operations_root_branch_unique_idx').on(table.rootBranchId)],
  )
}

/**
 * Package-local Drizzle table for direct Core and Worker DML.
 *
 * The host-composed schema recreates the same physical table with references to
 * its composed operation and branch tables.
 */
export const capsuleCreateOperationsTable = createCapsuleCreateOperationsTable(
  capsuleOperationsTable.id,
  capsuleBranchesTable.id,
)
