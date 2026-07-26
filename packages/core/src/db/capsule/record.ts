import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, timestamp, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { CapsuleLifecycleStatusValues } from '../../schemas'

export const capsuleLifecycleStatusEnum = pgEnum('capsule_lifecycle_status', CapsuleLifecycleStatusValues)

function createOwnerIdColumn(ownerIdColumn?: PgColumn) {
  return ownerIdColumn
    ? uuid('owner_id')
        .notNull()
        .references(() => ownerIdColumn, { onDelete: 'cascade' })
    : uuid('owner_id').notNull()
}

/**
 * Creates the durable capsule aggregate table.
 *
 * Logical archive state is represented by `archivedAt` and remains reversible.
 * Destroyed, creation-failed, and cleanup-required capsules remain durable for
 * audit rather than being physically removed.
 *
 * TODO(capsule-naming): Add a durable user-facing capsule name/handle to this
 * aggregate. Branch names must remain scoped to a capsule and cannot serve as
 * the capsule identity once snapshot-based forks exist.
 */
export function createCapsulesTable(ownerIdColumn?: PgColumn) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  return pgTable(
    'capsules',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      lifecycleStatus: capsuleLifecycleStatusEnum('lifecycle_status').notNull().default('provisioning'),
      archivedAt: timestamp('archived_at', {
        withTimezone: true,
        mode: 'date',
      }),
      destroyedAt: timestamp('destroyed_at', {
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
      index('capsules_owner_idx').on(table.ownerId),
      index('capsules_owner_lifecycle_status_idx').on(table.ownerId, table.lifecycleStatus),
      check(
        'capsules_destroyed_timestamp_check',
        sql`(
          (${table.lifecycleStatus} = 'destroyed' AND ${table.destroyedAt} IS NOT NULL)
          OR
          (${table.lifecycleStatus} <> 'destroyed' AND ${table.destroyedAt} IS NULL)
        )`,
      ),
      check(
        'capsules_destroy_requires_archive_check',
        sql`(
          ${table.lifecycleStatus} NOT IN ('destroying', 'destroyed')
          OR
          ${table.archivedAt} IS NOT NULL
        )`,
      ),
    ],
  )
}
