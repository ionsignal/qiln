import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgColumn,
} from 'drizzle-orm/pg-core'
import {
  CapsuleArtifactEntryTypeValues,
  type CapsuleArtifactContentDigest,
  type CapsuleArtifactLogicalPath,
  type CapsuleArtifactManifestDigest,
  type CapsuleArtifactRootId,
} from '../../../schemas'
import { capsuleSnapshotsTable } from './record'

export const capsuleArtifactEntryTypeEnum = pgEnum('capsule_artifact_entry_type', CapsuleArtifactEntryTypeValues)

function createSnapshotIdColumn(snapshotIdColumn?: PgColumn) {
  return snapshotIdColumn
    ? uuid('snapshot_id')
        .notNull()
        .references(() => snapshotIdColumn, { onDelete: 'cascade' })
    : uuid('snapshot_id').notNull()
}

function createManifestIdColumn(manifestIdColumn?: PgColumn) {
  return manifestIdColumn
    ? uuid('manifest_id')
        .notNull()
        .references(() => manifestIdColumn, { onDelete: 'cascade' })
    : uuid('manifest_id').notNull()
}

function createManifestRootIdColumn(manifestRootIdColumn?: PgColumn) {
  return manifestRootIdColumn
    ? uuid('manifest_root_id')
        .notNull()
        .references(() => manifestRootIdColumn, { onDelete: 'cascade' })
    : uuid('manifest_root_id').notNull()
}

/**
 * Creates the immutable canonical artifact-manifest header.
 *
 * A committed snapshot has exactly one manifest. Roots and entries are stored
 * relationally so future capture commit can reconstruct and validate the
 * canonical manifest before atomically linking it to committed history.
 */
export function createCapsuleArtifactManifestsTable(snapshotIdColumn?: PgColumn) {
  const snapshotId = createSnapshotIdColumn(snapshotIdColumn)
  return pgTable(
    'capsule_artifact_manifests',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      snapshotId,
      schemaVersion: integer('schema_version').notNull(),
      digest: text('digest').$type<CapsuleArtifactManifestDigest>().notNull(),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
    },
    table => [
      uniqueIndex('capsule_artifact_manifests_snapshot_unique_idx').on(table.snapshotId),
      index('capsule_artifact_manifests_digest_idx').on(table.digest),
      check('capsule_artifact_manifests_schema_version_check', sql`${table.schemaVersion} = 1`),
      check('capsule_artifact_manifests_digest_check', sql`${table.digest} ~ '^sha256:[a-f0-9]{64}$'`),
    ],
  )
}

/**
 * Creates logical manifest roots derived from the historical capture-policy
 * pin.
 *
 * `rootId` is the stable policy-facing artifact-root identity. The UUID primary
 * key is used by related evidence tables so physical foreign keys do not depend
 * on mutable or provider-specific names.
 */
export function createCapsuleArtifactManifestRootsTable(manifestIdColumn?: PgColumn) {
  const manifestId = createManifestIdColumn(manifestIdColumn)
  return pgTable(
    'capsule_artifact_manifest_roots',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      manifestId,
      rootId: text('root_id').$type<CapsuleArtifactRootId>().notNull(),
      logicalPath: text('logical_path').$type<CapsuleArtifactLogicalPath>().notNull(),
    },
    table => [
      index('capsule_artifact_manifest_roots_manifest_idx').on(table.manifestId),
      uniqueIndex('capsule_artifact_manifest_roots_manifest_root_unique_idx').on(table.manifestId, table.rootId),
      uniqueIndex('capsule_artifact_manifest_roots_manifest_path_unique_idx').on(table.manifestId, table.logicalPath),
    ],
  )
}

/**
 * Creates immutable canonical artifact entries.
 *
 * PostgreSQL stores file sizes as signed 64-bit integers while the public
 * contract limits them to JavaScript safe integers. Future writers must
 * validate the complete reconstructed manifest before commit.
 *
 * Millisecond-precision timestamptz preserves the canonical timestamp precision
 * accepted by the artifact contract.
 */
export function createCapsuleArtifactEntriesTable(manifestRootIdColumn?: PgColumn) {
  const manifestRootId = createManifestRootIdColumn(manifestRootIdColumn)
  return pgTable(
    'capsule_artifact_entries',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      manifestRootId,
      logicalPath: text('logical_path').$type<CapsuleArtifactLogicalPath>().notNull(),
      type: capsuleArtifactEntryTypeEnum('type').notNull(),
      mode: text('mode').notNull(),
      uid: integer('uid').notNull(),
      gid: integer('gid').notNull(),
      modifiedAt: timestamp('modified_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }).notNull(),
      size: bigint('size', {
        mode: 'number',
      }),
      contentDigest: text('content_digest').$type<CapsuleArtifactContentDigest>(),
    },
    table => [
      index('capsule_artifact_entries_root_idx').on(table.manifestRootId),
      uniqueIndex('capsule_artifact_entries_root_path_unique_idx').on(table.manifestRootId, table.logicalPath),
      check('capsule_artifact_entries_mode_check', sql`${table.mode} ~ '^[0-7]{4}$'`),
      check('capsule_artifact_entries_uid_check', sql`${table.uid} >= 0`),
      check('capsule_artifact_entries_gid_check', sql`${table.gid} >= 0`),
      check(
        'capsule_artifact_entries_file_fields_check',
        sql`(
          (
            ${table.type} = 'file'
            AND ${table.size} IS NOT NULL
            AND ${table.size} >= 0
            AND ${table.size} <= 9007199254740991
            AND ${table.contentDigest} IS NOT NULL
            AND ${table.contentDigest} ~ '^sha256:[a-f0-9]{64}$'
          )
          OR
          (
            ${table.type} = 'directory'
            AND ${table.size} IS NULL
            AND ${table.contentDigest} IS NULL
          )
        )`,
      ),
    ],
  )
}

export const capsuleArtifactManifestsTable = createCapsuleArtifactManifestsTable(capsuleSnapshotsTable.id)

export const capsuleArtifactManifestRootsTable = createCapsuleArtifactManifestRootsTable(
  capsuleArtifactManifestsTable.id,
)

export const capsuleArtifactEntriesTable = createCapsuleArtifactEntriesTable(capsuleArtifactManifestRootsTable.id)
