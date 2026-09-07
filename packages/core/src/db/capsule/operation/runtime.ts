import { index, pgTable, text, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import type { CapsuleBranchName } from '../../../schemas/capsule/branch'

function createOperationIdColumn(operationIdColumn?: PgColumn) {
  return operationIdColumn
    ? uuid('operation_id')
        .primaryKey()
        .references(() => operationIdColumn, { onDelete: 'cascade' })
    : uuid('operation_id').primaryKey()
}

function createBranchIdColumn(branchIdColumn?: PgColumn) {
  return branchIdColumn
    ? uuid('branch_id')
        .notNull()
        .references(() => branchIdColumn, { onDelete: 'restrict' })
    : uuid('branch_id').notNull()
}

/**
 * Immutable target identity for one branch start or stop operation.
 *
 * The base operation owns actor provenance, idempotency, execution state, and
 * provider intent. This extension records the exact branch UUID and its
 * acceptance-time name without duplicating mutable branch runtime state.
 *
 * Multiple operations may reference the same branch. Branch deletion remains
 * restricted while operation history references it.
 *
 * Foreign keys prove row identity, not operation type or ownership agreement.
 * Repositories must verify that the base operation is the expected branch_start
 * or branch_stop operation and that its owner and capsule match the branch.
 */
export function createCapsuleBranchRuntimeOperationsTable(operationIdColumn?: PgColumn, branchIdColumn?: PgColumn) {
  const operationId = createOperationIdColumn(operationIdColumn)
  const branchId = createBranchIdColumn(branchIdColumn)
  return pgTable(
    'capsule_branch_runtime_operations',
    {
      operationId,
      branchId,
      branchName: text('branch_name').$type<CapsuleBranchName>().notNull(),
    },
    table => [index('capsule_branch_runtime_operations_branch_idx').on(table.branchId)],
  )
}
