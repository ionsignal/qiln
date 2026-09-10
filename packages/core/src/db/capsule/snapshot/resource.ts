import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import {
  CapsuleSnapshotResourceKindValues,
  CapsuleSnapshotResourceProviderValues,
  type CapsuleBlueprintIdentifier,
} from '../../../schemas'

export const capsuleSnapshotResourceProviderEnum = pgEnum(
  'capsule_snapshot_resource_provider',
  CapsuleSnapshotResourceProviderValues,
)

export const capsuleSnapshotResourceKindEnum = pgEnum(
  'capsule_snapshot_resource_kind',
  CapsuleSnapshotResourceKindValues,
)

function createSnapshotIdColumn(snapshotIdColumn?: PgColumn) {
  return snapshotIdColumn
    ? uuid('snapshot_id')
        .notNull()
        .references(() => snapshotIdColumn, { onDelete: 'cascade' })
    : uuid('snapshot_id').notNull()
}

function createSourceResourceIdColumn(sourceResourceIdColumn?: PgColumn) {
  return sourceResourceIdColumn
    ? uuid('source_branch_resource_id')
        .notNull()
        .references(() => sourceResourceIdColumn, { onDelete: 'restrict' })
    : uuid('source_branch_resource_id').notNull()
}

function createResourceIdColumn(snapshotCreateResourceIdColumn?: PgColumn) {
  return snapshotCreateResourceIdColumn
    ? uuid('create_resource_id')
        .notNull()
        .references(() => snapshotCreateResourceIdColumn, { onDelete: 'restrict' })
    : uuid('create_resource_id').notNull()
}

/**
 * Immutable committed managed-volume restoration authority.
 *
 * Each reference retains the exact successful Create Snapshot resource whose
 * provider identity was copied into committed history. Atomic commit must prove
 * agreement with the source inventory, historical Blueprint, and base
 * operation.
 *
 * Every managed clone or empty Blueprint volume requires exactly one reference.
 * Bind mounts never receive references. Forks must not infer or rediscover
 * alternative provider snapshots.
 */
export function createCapsuleSnapshotResourceReferencesTable(
  snapshotIdColumn?: PgColumn,
  sourceResourceIdColumn?: PgColumn,
  snapshotCreateResourceIdColumn?: PgColumn,
) {
  const snapshotId = createSnapshotIdColumn(snapshotIdColumn)
  const sourceBranchResourceId = createSourceResourceIdColumn(sourceResourceIdColumn)
  const createResourceId = createResourceIdColumn(snapshotCreateResourceIdColumn)
  return pgTable(
    'capsule_snapshot_resource_references',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      snapshotId,
      sourceBranchResourceId,
      createResourceId,
      provider: capsuleSnapshotResourceProviderEnum('provider').notNull(),
      kind: capsuleSnapshotResourceKindEnum('kind').notNull(),
      blueprintVolumeName: text('blueprint_volume_name').$type<CapsuleBlueprintIdentifier>().notNull(),
      project: text('project').notNull(),
      pool: text('pool').notNull(),
      sourceVolume: text('source_volume').notNull(),
      snapshotName: text('snapshot_name').notNull(),
    },
    table => [
      index('capsule_snap_resource_ref_snapshot_idx').on(table.snapshotId),
      index('capsule_snap_resource_ref_source_resource_idx').on(table.sourceBranchResourceId),
      uniqueIndex('capsule_snap_resource_ref_create_resource_unique_idx').on(table.createResourceId),
      uniqueIndex('capsule_snap_resource_ref_snapshot_source_unique_idx').on(
        table.snapshotId,
        table.sourceBranchResourceId,
      ),
      uniqueIndex('capsule_snap_resource_ref_snapshot_volume_unique_idx').on(
        table.snapshotId,
        table.blueprintVolumeName,
      ),
      uniqueIndex('capsule_snap_resource_ref_provider_identity_unique_idx').on(
        table.provider,
        table.project,
        table.pool,
        table.sourceVolume,
        table.snapshotName,
      ),
      check(
        'capsule_snap_resource_ref_identity_check',
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
