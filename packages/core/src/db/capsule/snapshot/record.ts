import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import type {
  CapsuleBranchName,
  CapsuleBranchResourceInventoryDigest,
  CapsuleSnapshotCapturePolicyDigest,
  CapsuleSnapshotCapturePolicyPin,
} from '../../../schemas'
import { capsuleBranchesTable } from '../branch/record'
import { capsulesTable } from '../record'

function createCapsuleIdColumn(capsuleIdColumn?: PgColumn) {
  return capsuleIdColumn
    ? uuid('capsule_id')
        .notNull()
        .references(() => capsuleIdColumn, { onDelete: 'restrict' })
    : uuid('capsule_id').notNull()
}

function createSourceBranchIdColumn(sourceBranchIdColumn?: PgColumn) {
  return sourceBranchIdColumn
    ? uuid('source_branch_id')
        .notNull()
        .references(() => sourceBranchIdColumn, { onDelete: 'restrict' })
    : uuid('source_branch_id').notNull()
}

/**
 * Creates immutable committed capsule snapshot history.
 *
 * A row is a committed-history marker, not staging or execution state. Future
 * Snapshot Capture must insert this row and its complete evidence graph in the
 * same transaction that links the capture operation result and terminalizes the
 * base operation.
 *
 * `archivedAt` is the only intentionally mutable lifecycle field. Capture
 * policy, source identity, resource-inventory evidence, manifest evidence, Git
 * records, dependency references, and physical provider references are
 * immutable by repository policy.
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
      sourceBranchName: text('source_branch_name').$type<CapsuleBranchName>().notNull(),
      sourceBranchResourceInventoryDigest: text('source_branch_resource_inventory_digest')
        .$type<CapsuleBranchResourceInventoryDigest>()
        .notNull(),
      capturePolicySchemaVersion: integer('capture_policy_schema_version').notNull(),
      capturePolicyDigest: text('capture_policy_digest').$type<CapsuleSnapshotCapturePolicyDigest>().notNull(),
      capturePolicyPin: jsonb('capture_policy_pin').$type<CapsuleSnapshotCapturePolicyPin>().notNull(),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
      archivedAt: timestamp('archived_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
    },
    table => [
      index('capsule_snapshots_capsule_created_idx').on(table.capsuleId, table.createdAt),
      index('capsule_snapshots_source_branch_idx').on(table.sourceBranchId),
      index('capsule_snapshots_policy_digest_idx').on(table.capturePolicyDigest),
      check('capsule_snapshots_policy_schema_check', sql`${table.capturePolicySchemaVersion} = 1`),
      check('capsule_snapshots_policy_digest_check', sql`${table.capturePolicyDigest} ~ '^sha256:[a-f0-9]{64}$'`),
      check(
        'capsule_snapshots_inventory_digest_check',
        sql`${table.sourceBranchResourceInventoryDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
      check(
        'capsule_snapshots_archive_timestamp_check',
        sql`${table.archivedAt} IS NULL OR ${table.archivedAt} >= ${table.createdAt}`,
      ),
    ],
  )
}

/**
 * Package-local Drizzle table for direct Core and Worker reads.
 *
 * The host-composed schema recreates the same physical table with references to
 * its composed capsule and branch tables.
 */
export const capsuleSnapshotsTable = createCapsuleSnapshotsTable(capsulesTable.id, capsuleBranchesTable.id)
