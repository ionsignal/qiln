import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import type { CapsuleArtifactManifestDigest } from '../../schemas'
import { capsuleBranchesTable } from './branch'
import { capsulesTable } from './capsule'

function createCapsuleIdColumn(capsuleIdColumn?: PgColumn) {
  return capsuleIdColumn
    ? uuid('capsule_id')
        .notNull()
        .references(() => capsuleIdColumn, { onDelete: 'cascade' })
    : uuid('capsule_id').notNull()
}

function createSourceBranchIdColumn(sourceBranchIdColumn?: PgColumn) {
  return sourceBranchIdColumn
    ? uuid('source_branch_id')
        .notNull()
        .references(() => sourceBranchIdColumn)
    : uuid('source_branch_id').notNull()
}

/**
 * Creates immutable logical snapshot-record headers.
 *
 * A row represents a committed snapshot only after a future capture operation
 * has proven its canonical artifact manifest and physical references complete.
 * This table intentionally contains no writer behavior, provider snapshot ID,
 * route-alias state, approval state, or mutable runtime metadata.
 */
export function createCapsuleSnapshotsTable(capsuleIdColumn?: PgColumn, sourceBranchIdColumn?: PgColumn) {
  const capsuleId = createCapsuleIdColumn(capsuleIdColumn)
  const sourceBranchId = createSourceBranchIdColumn(sourceBranchIdColumn)
  return pgTable(
    'capsule_snapshots',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      capsuleId,
      sourceBranchId,
      artifactManifestSchemaVersion: integer('artifact_manifest_schema_version').notNull(),
      artifactManifestDigest: text('artifact_manifest_digest').$type<CapsuleArtifactManifestDigest>().notNull(),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      archivedAt: timestamp('archived_at', {
        withTimezone: true,
        mode: 'date',
      }),
    },
    table => [
      index('capsule_snapshots_capsule_created_idx').on(table.capsuleId, table.createdAt),
      index('capsule_snapshots_source_branch_idx').on(table.sourceBranchId),
    ],
  )
}

/**
 * Package-local Drizzle table for direct Core/Worker reads against the host-owned
 * physical table. The host-composed schema owns the users foreign key through
 * the capsule aggregate.
 */
export const capsuleSnapshotsTable = createCapsuleSnapshotsTable(capsulesTable.id, capsuleBranchesTable.id)
