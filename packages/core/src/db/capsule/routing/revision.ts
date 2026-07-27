import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  type PgColumn,
} from 'drizzle-orm/pg-core'
import {
  CapsuleRouteRevisionActionValues,
  CapsuleRouteRevisionStatusValues,
  type CapsuleRouteEvidencePin,
  type CapsuleRouteTargetPin,
} from '../../../schemas'

export const capsuleRouteRevisionActionEnum = pgEnum('capsule_route_revision_action', CapsuleRouteRevisionActionValues)
export const capsuleRouteRevisionStatusEnum = pgEnum('capsule_route_revision_status', CapsuleRouteRevisionStatusValues)

function createAliasIdColumn(aliasIdColumn?: PgColumn) {
  return aliasIdColumn
    ? uuid('alias_id')
        .notNull()
        .references(() => aliasIdColumn, { onDelete: 'cascade' })
    : uuid('alias_id').notNull()
}

function createSnapshotIdColumn(snapshotIdColumn?: PgColumn) {
  return snapshotIdColumn
    ? uuid('snapshot_id')
        .notNull()
        .references(() => snapshotIdColumn, { onDelete: 'restrict' })
    : uuid('snapshot_id').notNull()
}

function createOperationIdColumn(operationIdColumn?: PgColumn) {
  return operationIdColumn
    ? uuid('operation_id')
        .notNull()
        .references(() => operationIdColumn, { onDelete: 'restrict' })
    : uuid('operation_id').notNull()
}

/**
 * Creates append-only route revision history.
 *
 * Target and evidence pins are immutable operation input. Status and terminal
 * timestamps are the only fields intended to change after proposal insertion.
 *
 * A rollback creates a new row whose target must match the selected committed
 * `rollbackSourceRevisionId`; it never reactivates or mutates that historical
 * row.
 */
export function createCapsuleRouteRevisionsTable(
  aliasIdColumn?: PgColumn,
  snapshotIdColumn?: PgColumn,
  operationIdColumn?: PgColumn,
) {
  const aliasId = createAliasIdColumn(aliasIdColumn)
  const snapshotId = createSnapshotIdColumn(snapshotIdColumn)
  const operationId = createOperationIdColumn(operationIdColumn)
  return pgTable(
    'capsule_route_revisions',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      aliasId,
      number: integer('number').notNull(),
      action: capsuleRouteRevisionActionEnum('action').notNull(),
      previousRevisionId: uuid('previous_revision_id'),
      rollbackSourceRevisionId: uuid('rollback_source_revision_id'),
      snapshotId,
      targetPin: jsonb('target_pin').$type<CapsuleRouteTargetPin>().notNull(),
      evidencePin: jsonb('evidence_pin').$type<CapsuleRouteEvidencePin>().notNull(),
      operationId,
      status: capsuleRouteRevisionStatusEnum('status').notNull().default('proposed'),
      proposedAt: timestamp('proposed_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
      committedAt: timestamp('committed_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      failedAt: timestamp('failed_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
    },
    table => [
      index('capsule_route_revisions_alias_idx').on(table.aliasId),
      index('capsule_route_revisions_snapshot_idx').on(table.snapshotId),
      index('capsule_route_revisions_previous_idx').on(table.previousRevisionId),
      index('capsule_route_revisions_rollback_source_idx').on(table.rollbackSourceRevisionId),
      index('capsule_route_revisions_status_idx').on(table.status),
      uniqueIndex('capsule_route_revisions_alias_number_unique_idx').on(table.aliasId, table.number),
      uniqueIndex('capsule_route_revisions_operation_unique_idx').on(table.operationId),
      uniqueIndex('capsule_route_revisions_alias_id_unique_idx').on(table.aliasId, table.id),
      uniqueIndex('capsule_route_revisions_operation_id_unique_idx').on(table.operationId, table.id),
      foreignKey({
        columns: [table.aliasId, table.previousRevisionId],
        foreignColumns: [table.aliasId, table.id],
        name: 'capsule_route_revisions_previous_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.aliasId, table.rollbackSourceRevisionId],
        foreignColumns: [table.aliasId, table.id],
        name: 'capsule_route_revisions_rollback_source_fk',
      }).onDelete('restrict'),
      check('capsule_route_revisions_number_check', sql`${table.number} > 0`),
      check(
        'capsule_route_revisions_action_check',
        sql`(
          (
            ${table.action} = 'promote'
            AND ${table.rollbackSourceRevisionId} IS NULL
          )
          OR
          (
            ${table.action} = 'rollback'
            AND ${table.previousRevisionId} IS NOT NULL
            AND ${table.rollbackSourceRevisionId} IS NOT NULL
          )
        )`,
      ),
      check(
        'capsule_route_revisions_terminal_state_check',
        sql`(
          (
            ${table.status} = 'proposed'
            AND ${table.committedAt} IS NULL
            AND ${table.failedAt} IS NULL
          )
          OR
          (
            ${table.status} = 'committed'
            AND ${table.committedAt} IS NOT NULL
            AND ${table.failedAt} IS NULL
          )
          OR
          (
            ${table.status} IN ('failed', 'cleanup_required')
            AND ${table.committedAt} IS NULL
            AND ${table.failedAt} IS NOT NULL
          )
        )`,
      ),
      check(
        'capsule_route_revisions_timestamp_order_check',
        sql`(
          (${table.committedAt} IS NULL OR ${table.committedAt} >= ${table.proposedAt})
          AND
          (${table.failedAt} IS NULL OR ${table.failedAt} >= ${table.proposedAt})
        )`,
      ),
    ],
  )
}
