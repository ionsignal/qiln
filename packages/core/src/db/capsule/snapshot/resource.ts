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

function createManifestRootIdColumn(manifestRootIdColumn?: PgColumn) {
  return manifestRootIdColumn
    ? uuid('manifest_root_id')
        .notNull()
        .references(() => manifestRootIdColumn, { onDelete: 'restrict' })
    : uuid('manifest_root_id').notNull()
}

function createSourceResourceIdColumn(sourceResourceIdColumn?: PgColumn) {
  return sourceResourceIdColumn
    ? uuid('source_branch_resource_id')
        .notNull()
        .references(() => sourceResourceIdColumn, { onDelete: 'restrict' })
    : uuid('source_branch_resource_id').notNull()
}

/**
 * Creates immutable physical provider snapshot references.
 *
 * These rows are the only future fork authority for managed storage. Provider
 * snapshot identities must never be rediscovered or inferred from live Incus
 * inventory after capture commit.
 */
export function createCapsuleSnapshotResourceReferencesTable(
  snapshotIdColumn?: PgColumn,
  manifestRootIdColumn?: PgColumn,
  sourceResourceIdColumn?: PgColumn,
) {
  const snapshotId = createSnapshotIdColumn(snapshotIdColumn)
  const manifestRootId = createManifestRootIdColumn(manifestRootIdColumn)
  const sourceBranchResourceId = createSourceResourceIdColumn(sourceResourceIdColumn)

  return pgTable(
    'capsule_snapshot_resource_references',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      snapshotId,
      manifestRootId,
      sourceBranchResourceId,
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
      index('capsule_snap_resource_ref_root_idx').on(table.manifestRootId),
      index('capsule_snap_resource_ref_source_resource_idx').on(table.sourceBranchResourceId),
      uniqueIndex('capsule_snap_resource_ref_snapshot_root_unique_idx').on(table.snapshotId, table.manifestRootId),
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
