import { sql } from 'drizzle-orm'
import { check, foreignKey, index, pgTable, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { capsuleRouteRevisionActionEnum } from './revision'

function createOperationIdColumn(operationIdColumn?: PgColumn) {
  return operationIdColumn
    ? uuid('operation_id')
        .primaryKey()
        .references(() => operationIdColumn, { onDelete: 'restrict' })
    : uuid('operation_id').primaryKey()
}

function createAliasIdColumn(aliasIdColumn?: PgColumn) {
  return aliasIdColumn
    ? uuid('alias_id')
        .notNull()
        .references(() => aliasIdColumn, { onDelete: 'restrict' })
    : uuid('alias_id').notNull()
}

function createNullableRevisionIdColumn(columnName: string, revisionIdColumn?: PgColumn) {
  const column = uuid(columnName)
  return revisionIdColumn
    ? column.references(() => revisionIdColumn, {
        onDelete: 'restrict',
      })
    : column
}

function createProposedRevisionIdColumn(revisionIdColumn?: PgColumn) {
  return revisionIdColumn
    ? uuid('proposed_revision_id')
        .notNull()
        .references(() => revisionIdColumn, { onDelete: 'restrict' })
    : uuid('proposed_revision_id').notNull()
}

/**
 * Creates immutable route-mutation operation input.
 *
 * Composite foreign keys prove that expected, proposed, and rollback-source
 * revisions belong to the selected alias and that the proposed revision belongs
 * to the same base operation. PostgreSQL still cannot prove that the base
 * operation discriminator agrees with `action`. Promotion and rollback
 * repositories must validate that relationship whenever this extension
 * authorizes execution, finalization, replay, or abandonment classification.
 */
export function createCapsuleRouteOperationsTable(
  operationIdColumn?: PgColumn,
  aliasIdColumn?: PgColumn,
  revisionIdColumn?: PgColumn,
  revisionAliasIdColumn?: PgColumn,
  revisionOperationIdColumn?: PgColumn,
) {
  const operationId = createOperationIdColumn(operationIdColumn)
  const aliasId = createAliasIdColumn(aliasIdColumn)
  const expectedRevisionId = createNullableRevisionIdColumn('expected_revision_id', revisionIdColumn)
  const proposedRevisionId = createProposedRevisionIdColumn(revisionIdColumn)
  const rollbackSourceRevisionId = createNullableRevisionIdColumn('rollback_source_revision_id', revisionIdColumn)
  return pgTable(
    'capsule_route_operations',
    {
      operationId,
      aliasId,
      action: capsuleRouteRevisionActionEnum('action').notNull(),
      expectedRevisionId,
      proposedRevisionId,
      rollbackSourceRevisionId,
    },
    table => [
      index('capsule_route_operations_alias_idx').on(table.aliasId),
      index('capsule_route_operations_expected_revision_idx').on(table.expectedRevisionId),
      index('capsule_route_operations_rollback_source_idx').on(table.rollbackSourceRevisionId),
      uniqueIndex('capsule_route_operations_proposed_revision_unique_idx').on(table.proposedRevisionId),
      ...(revisionAliasIdColumn && revisionIdColumn
        ? [
            foreignKey({
              columns: [table.aliasId, table.proposedRevisionId],
              foreignColumns: [revisionAliasIdColumn, revisionIdColumn],
              name: 'capsule_route_operations_proposed_alias_revision_fk',
            }).onDelete('restrict'),
            foreignKey({
              columns: [table.aliasId, table.expectedRevisionId],
              foreignColumns: [revisionAliasIdColumn, revisionIdColumn],
              name: 'capsule_route_operations_expected_alias_revision_fk',
            }).onDelete('restrict'),
            foreignKey({
              columns: [table.aliasId, table.rollbackSourceRevisionId],
              foreignColumns: [revisionAliasIdColumn, revisionIdColumn],
              name: 'capsule_route_operations_rollback_alias_revision_fk',
            }).onDelete('restrict'),
          ]
        : []),
      ...(revisionOperationIdColumn && revisionIdColumn
        ? [
            foreignKey({
              columns: [table.operationId, table.proposedRevisionId],
              foreignColumns: [revisionOperationIdColumn, revisionIdColumn],
              name: 'capsule_route_operations_proposed_operation_revision_fk',
            }).onDelete('restrict'),
          ]
        : []),
      check(
        'capsule_route_operations_action_check',
        sql`(
          (
            ${table.action} = 'promote'
            AND ${table.rollbackSourceRevisionId} IS NULL
          )
          OR
          (
            ${table.action} = 'rollback'
            AND ${table.expectedRevisionId} IS NOT NULL
            AND ${table.rollbackSourceRevisionId} IS NOT NULL
          )
        )`,
      ),
    ],
  )
}
