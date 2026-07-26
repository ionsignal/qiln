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
import {
  CapsuleSnapshotCaptureResourceStatusValues,
  type CapsuleArtifactRootId,
  type CapsuleBlueprintIdentifier,
} from '../../../../schemas'
import { capsuleSnapshotResourceKindEnum, capsuleSnapshotResourceProviderEnum } from '../../snapshot/resource'

export const capsuleSnapshotCaptureResourceStatusEnum = pgEnum(
  'capsule_snapshot_capture_resource_status',
  CapsuleSnapshotCaptureResourceStatusValues,
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
 * Creates operation-scoped accounting for planned physical provider snapshots.
 *
 * These rows record deterministic provider identity, intent, outcomes, cleanup,
 * and uncertainty during Snapshot Capture. They are not committed snapshot
 * history and cannot authorize a branch fork.
 *
 * The future atomic capture commit transaction must validate successful rows
 * and copy their immutable provider identities into
 * `capsule_snapshot_resource_references`.
 */
export function createCapsuleSnapshotCaptureResourcesTable(
  operationIdColumn?: PgColumn,
  sourceResourceIdColumn?: PgColumn,
) {
  const operationId = createOperationIdColumn(operationIdColumn)
  const sourceBranchResourceId = createSourceResourceIdColumn(sourceResourceIdColumn)
  return pgTable(
    'capsule_snapshot_capture_resources',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      operationId,
      sourceBranchResourceId,
      artifactRootId: text('artifact_root_id').$type<CapsuleArtifactRootId>().notNull(),
      blueprintVolumeName: text('blueprint_volume_name').$type<CapsuleBlueprintIdentifier>().notNull(),
      provider: capsuleSnapshotResourceProviderEnum('provider').notNull(),
      kind: capsuleSnapshotResourceKindEnum('kind').notNull(),
      project: text('project').notNull(),
      pool: text('pool').notNull(),
      sourceVolume: text('source_volume').notNull(),
      snapshotName: text('snapshot_name').notNull(),
      status: capsuleSnapshotCaptureResourceStatusEnum('status').notNull().default('planned'),
      snapshotIntentAt: timestamp('snapshot_intent_at', {
        withTimezone: true,
        mode: 'date',
      }),
      snapshotCreatedAt: timestamp('snapshot_created_at', {
        withTimezone: true,
        mode: 'date',
      }),
      cleanupIntentAt: timestamp('cleanup_intent_at', {
        withTimezone: true,
        mode: 'date',
      }),
      cleanupCompletedAt: timestamp('cleanup_completed_at', {
        withTimezone: true,
        mode: 'date',
      }),
      failureCode: text('failure_code'),
      failureMessage: text('failure_message'),
      failureDetails: jsonb('failure_details').$type<Record<string, unknown>>(),
      failureAt: timestamp('failure_at', {
        withTimezone: true,
        mode: 'date',
      }),
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
      index('capsule_snapshot_capture_resources_operation_idx').on(table.operationId),
      index('capsule_snapshot_capture_resources_source_resource_idx').on(table.sourceBranchResourceId),
      index('capsule_snapshot_capture_resources_status_idx').on(table.status),
      uniqueIndex('capsule_snapshot_capture_resources_operation_root_unique_idx').on(
        table.operationId,
        table.artifactRootId,
      ),
      uniqueIndex('capsule_snapshot_capture_resources_operation_volume_unique_idx').on(
        table.operationId,
        table.blueprintVolumeName,
      ),
      uniqueIndex('capsule_snapshot_capture_resources_operation_source_unique_idx').on(
        table.operationId,
        table.sourceBranchResourceId,
      ),
      uniqueIndex('capsule_snapshot_capture_resources_provider_identity_unique_idx').on(
        table.provider,
        table.project,
        table.pool,
        table.sourceVolume,
        table.snapshotName,
      ),
      check(
        'capsule_snapshot_capture_resources_identity_check',
        sql`(
          length(btrim(${table.project})) BETWEEN 1 AND 255
          AND length(btrim(${table.pool})) BETWEEN 1 AND 255
          AND length(btrim(${table.sourceVolume})) BETWEEN 1 AND 255
          AND length(btrim(${table.snapshotName})) BETWEEN 1 AND 255
        )`,
      ),
      check(
        'capsule_snapshot_capture_resources_timeline_check',
        sql`(
          (
            ${table.status} = 'planned'
            AND ${table.snapshotIntentAt} IS NULL
            AND ${table.snapshotCreatedAt} IS NULL
            AND ${table.cleanupIntentAt} IS NULL
            AND ${table.cleanupCompletedAt} IS NULL
          )
          OR
          (
            ${table.status} = 'creating'
            AND ${table.snapshotIntentAt} IS NOT NULL
            AND ${table.snapshotCreatedAt} IS NULL
            AND ${table.cleanupIntentAt} IS NULL
            AND ${table.cleanupCompletedAt} IS NULL
          )
          OR
          (
            ${table.status} = 'created'
            AND ${table.snapshotIntentAt} IS NOT NULL
            AND ${table.snapshotCreatedAt} IS NOT NULL
            AND ${table.cleanupIntentAt} IS NULL
            AND ${table.cleanupCompletedAt} IS NULL
          )
          OR
          (
            ${table.status} = 'deleting'
            AND ${table.snapshotIntentAt} IS NOT NULL
            AND ${table.snapshotCreatedAt} IS NOT NULL
            AND ${table.cleanupIntentAt} IS NOT NULL
            AND ${table.cleanupCompletedAt} IS NULL
          )
          OR
          (
            ${table.status} IN ('deleted', 'missing')
            AND ${table.snapshotIntentAt} IS NOT NULL
            AND ${table.snapshotCreatedAt} IS NOT NULL
            AND ${table.cleanupIntentAt} IS NOT NULL
            AND ${table.cleanupCompletedAt} IS NOT NULL
          )
          OR
          (
            ${table.status} = 'error'
            AND ${table.snapshotIntentAt} IS NOT NULL
          )
        )`,
      ),
      check(
        'capsule_snapshot_capture_resources_failure_check',
        sql`(
          (
            ${table.status} = 'error'
            AND ${table.failureCode} IS NOT NULL
            AND ${table.failureMessage} IS NOT NULL
            AND ${table.failureDetails} IS NOT NULL
            AND ${table.failureAt} IS NOT NULL
          )
          OR
          (
            ${table.status} <> 'error'
            AND ${table.failureCode} IS NULL
            AND ${table.failureMessage} IS NULL
            AND ${table.failureDetails} IS NULL
            AND ${table.failureAt} IS NULL
          )
        )`,
      ),
      check(
        'capsule_snapshot_capture_resources_timestamp_order_check',
        sql`(
          (
            ${table.snapshotCreatedAt} IS NULL
            OR (
              ${table.snapshotIntentAt} IS NOT NULL
              AND ${table.snapshotCreatedAt} >= ${table.snapshotIntentAt}
            )
          )
          AND
          (
            ${table.cleanupIntentAt} IS NULL
            OR (
              ${table.snapshotCreatedAt} IS NOT NULL
              AND ${table.cleanupIntentAt} >= ${table.snapshotCreatedAt}
            )
          )
          AND
          (
            ${table.cleanupCompletedAt} IS NULL
            OR (
              ${table.cleanupIntentAt} IS NOT NULL
              AND ${table.cleanupCompletedAt} >= ${table.cleanupIntentAt}
            )
          )
        )`,
      ),
    ],
  )
}
