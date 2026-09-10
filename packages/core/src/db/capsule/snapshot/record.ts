import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import type {
  CapsuleBlueprintDigest,
  CapsuleBlueprintPin,
  CapsuleBranchName,
  CapsuleBranchResourceInventoryDigest,
  CapsuleRootfsImagePin,
} from '../../../schemas'

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
 * Immutable committed restoration evidence for one capsule branch state.
 *
 * Create Snapshot inserts this row and every managed-volume provider reference
 * in the same transaction that links the operation result and completes the
 * base operation. This table is never staging or execution state.
 *
 * Historical Blueprint configuration and the exact rootfs image pin authorize
 * reconstruction without consulting mutable catalogs or image aliases.
 *
 * Bind mounts remain unversioned external configuration. A snapshot does not
 * guarantee their contents or availability, mutable rootfs changes, application
 * correctness, Git history, or a detailed explanation of changes.
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
      blueprintSchemaVersion: integer('blueprint_schema_version').notNull(),
      blueprintName: text('blueprint_name').notNull(),
      blueprintDigest: text('blueprint_digest').$type<CapsuleBlueprintDigest>().notNull(),
      blueprintPin: jsonb('blueprint_pin').$type<CapsuleBlueprintPin>().notNull(),
      rootfsImagePin: jsonb('rootfs_image_pin').$type<CapsuleRootfsImagePin>().notNull(),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
    },
    table => [
      index('capsule_snapshots_capsule_created_idx').on(table.capsuleId, table.createdAt),
      index('capsule_snapshots_source_branch_idx').on(table.sourceBranchId),
      index('capsule_snapshots_blueprint_digest_idx').on(table.blueprintDigest),
      check('capsule_snapshots_blueprint_schema_check', sql`${table.blueprintSchemaVersion} = 1`),
      check('capsule_snapshots_blueprint_digest_check', sql`${table.blueprintDigest} ~ '^sha256:[a-f0-9]{64}$'`),
      check(
        'capsule_snapshots_inventory_digest_check',
        sql`${table.sourceBranchResourceInventoryDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
    ],
  )
}
