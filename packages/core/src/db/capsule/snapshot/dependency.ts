import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import {
  CapsuleSnapshotDependencyDigestKindValues,
  CapsuleSnapshotDependencyKindValues,
  type CapsuleBlueprintIdentifier,
  type CapsuleSnapshotDependencyDigest,
} from '../../../schemas'

export const capsuleSnapshotDependencyKindEnum = pgEnum(
  'capsule_snapshot_dependency_kind',
  CapsuleSnapshotDependencyKindValues,
)

export const capsuleSnapshotDependencyDigestKindEnum = pgEnum(
  'capsule_snapshot_dependency_digest_kind',
  CapsuleSnapshotDependencyDigestKindValues,
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
 * Creates immutable evidence for external capture boundaries.
 *
 * Each dependency remains bound to the manifest root containing its external
 * mount and to the durable source bind-mount resource that established that
 * boundary. Future capture commit must prove those identities agree with the
 * persisted capture-policy pin and source branch.
 */
export function createCapsuleSnapshotDependencyReferencesTable(
  snapshotIdColumn?: PgColumn,
  manifestRootIdColumn?: PgColumn,
  sourceResourceIdColumn?: PgColumn,
) {
  const snapshotId = createSnapshotIdColumn(snapshotIdColumn)
  const manifestRootId = createManifestRootIdColumn(manifestRootIdColumn)
  const sourceBranchResourceId = createSourceResourceIdColumn(sourceResourceIdColumn)
  return pgTable(
    'capsule_snapshot_dependency_references',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      snapshotId,
      manifestRootId,
      sourceBranchResourceId,
      kind: capsuleSnapshotDependencyKindEnum('kind').notNull(),
      logicalId: text('logical_id').$type<CapsuleBlueprintIdentifier>().notNull(),
      blueprintVolumeName: text('blueprint_volume_name').$type<CapsuleBlueprintIdentifier>().notNull(),
      revision: text('revision').notNull(),
      digestKind: capsuleSnapshotDependencyDigestKindEnum('digest_kind').notNull(),
      digest: text('digest').$type<CapsuleSnapshotDependencyDigest>().notNull(),
    },
    table => [
      index('capsule_snap_dependency_ref_snapshot_idx').on(table.snapshotId),
      index('capsule_snap_dependency_ref_root_idx').on(table.manifestRootId),
      index('capsule_snap_dependency_ref_source_resource_idx').on(table.sourceBranchResourceId),
      uniqueIndex('capsule_snap_dependency_ref_snapshot_identity_unique_idx').on(
        table.snapshotId,
        table.kind,
        table.logicalId,
      ),
      uniqueIndex('capsule_snap_dependency_ref_snapshot_volume_unique_idx').on(
        table.snapshotId,
        table.blueprintVolumeName,
      ),
      check('capsule_snap_dependency_ref_revision_check', sql`length(btrim(${table.revision})) BETWEEN 1 AND 512`),
      check('capsule_snap_dependency_ref_digest_check', sql`${table.digest} ~ '^sha256:[a-f0-9]{64}$'`),
    ],
  )
}
