import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgColumn,
} from 'drizzle-orm/pg-core'
import { CapsuleSnapshotCreateResourceStatusValues, type CapsuleBlueprintIdentifier } from '../../../../schemas'
import { capsuleSnapshotResourceKindEnum, capsuleSnapshotResourceProviderEnum } from '../../snapshot/resource'

export const capsuleSnapshotCreateResourceStatusEnum = pgEnum(
  'capsule_snapshot_create_resource_status',
  CapsuleSnapshotCreateResourceStatusValues,
)

function createOperationIdColumn(operationIdColumn?: PgColumn) {
  return operationIdColumn
    ? uuid('operation_id')
        .notNull()
        .references(() => operationIdColumn, { onDelete: 'restrict' })
    : uuid('operation_id').notNull()
}

function createSourceResourceIdColumn(sourceResourceIdColumn?: PgColumn) {
  return sourceResourceIdColumn
    ? uuid('source_branch_resource_id')
        .notNull()
        .references(() => sourceResourceIdColumn, { onDelete: 'restrict' })
    : uuid('source_branch_resource_id').notNull()
}

/**
 * Operation-scoped accounting for one planned managed-volume provider snapshot.
 *
 * Provider identities are accepted before execution and remain immutable.
 * Status, failure diagnostics, and accounting timestamps track execution and
 * compensation without becoming committed restoration authority.
 *
 * The base operation owns provider-intent fencing. Worker transactions must
 * persist that fence and resource execution state before provider mutation.
 * Uncertain outcomes require conservative cleanup handling rather than treating
 * a planned identity or interrupted status as proof of success.
 *
 * Atomic snapshot commit must prove complete managed-volume coverage and
 * agreement with the source inventory, historical Blueprint, and successful
 * provider outcomes before copying references into committed snapshot history.
 * Bind mounts never receive operation-scoped provider snapshot rows.
 */
export function createCapsuleSnapshotCreateResourcesTable(
  operationIdColumn?: PgColumn,
  sourceResourceIdColumn?: PgColumn,
) {
  const operationId = createOperationIdColumn(operationIdColumn)
  const sourceBranchResourceId = createSourceResourceIdColumn(sourceResourceIdColumn)
  return pgTable(
    'capsule_snapshot_create_resources',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      operationId,
      sourceBranchResourceId,
      provider: capsuleSnapshotResourceProviderEnum('provider').notNull(),
      kind: capsuleSnapshotResourceKindEnum('kind').notNull(),
      blueprintVolumeName: text('blueprint_volume_name').$type<CapsuleBlueprintIdentifier>().notNull(),
      project: text('project').notNull(),
      pool: text('pool').notNull(),
      sourceVolume: text('source_volume').notNull(),
      snapshotName: text('snapshot_name').notNull(),
      status: capsuleSnapshotCreateResourceStatusEnum('status').notNull().default('planned'),
      failureCode: text('failure_code'),
      failureMessage: text('failure_message'),
      failureDetails: jsonb('failure_details').$type<Record<string, unknown>>(),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp('updated_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
    },
    table => [
      index('capsule_snap_create_resources_operation_idx').on(table.operationId),
      index('capsule_snap_create_resources_source_resource_idx').on(table.sourceBranchResourceId),
      index('capsule_snap_create_resources_status_idx').on(table.status),
      uniqueIndex('capsule_snap_create_resources_operation_source_unique_idx').on(
        table.operationId,
        table.sourceBranchResourceId,
      ),
      uniqueIndex('capsule_snap_create_resources_operation_volume_unique_idx').on(
        table.operationId,
        table.blueprintVolumeName,
      ),
      uniqueIndex('capsule_snap_create_resources_provider_identity_unique_idx').on(
        table.provider,
        table.project,
        table.pool,
        table.sourceVolume,
        table.snapshotName,
      ),
      check(
        'capsule_snap_create_resources_identity_check',
        sql`(
          length(btrim(${table.project})) BETWEEN 1 AND 255
          AND length(btrim(${table.pool})) BETWEEN 1 AND 255
          AND length(btrim(${table.sourceVolume})) BETWEEN 1 AND 255
          AND length(btrim(${table.snapshotName})) BETWEEN 1 AND 255
        )`,
      ),
    ],
  )
}
