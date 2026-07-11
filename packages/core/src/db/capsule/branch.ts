import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, pgEnum, index, uniqueIndex, type PgColumn } from 'drizzle-orm/pg-core'
import { CapsuleBranchStatusValues, DEFAULT_CAPSULE_BLUEPRINT_NAME } from '../../protocol/capsule/messages'
import type { CapsuleBranchResourceInventoryDigest } from '../../schemas'

/**
 * Canonical database enum for capsule branch runtime state.
 *
 * The values are imported from the capsule protocol so Postgres, tRPC output,
 * realtime events, and worker command handling remain aligned.
 */
export const capsuleBranchStatusEnum = pgEnum('capsule_branch_status', CapsuleBranchStatusValues)

/**
 * Creates the physical `capsule_branches` table shape.
 *
 * The optional FK column keeps host schema composition authoritative while still giving engine/worker
 * packages a real Drizzle table object for DML typing without fabricating a fake users column.
 */
export function createCapsuleBranchesTable(ownerIdColumn?: PgColumn) {
  const ownerId = ownerIdColumn
    ? uuid('owner_id')
        .notNull()
        .references(() => ownerIdColumn, { onDelete: 'cascade' })
    : uuid('owner_id').notNull()
  return pgTable(
    'capsule_branches',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      runtimeIp: text('runtime_ip'),
      name: text('name').notNull(),
      cpu: text('cpu').notNull().default('4'),
      memory: text('memory').notNull().default('4GB'),
      blueprintName: text('blueprint_name').notNull().default(DEFAULT_CAPSULE_BLUEPRINT_NAME),
      blueprintDigest: text('blueprint_digest').notNull(),
      resourceInventoryDigest: text('resource_inventory_digest').$type<CapsuleBranchResourceInventoryDigest>(),
      status: capsuleBranchStatusEnum('status').notNull().default('provisioning'),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    table => [
      index('capsule_branches_owner_idx').on(table.ownerId),
      uniqueIndex('capsule_branches_owner_active_name_unique_idx')
        .on(table.ownerId, table.name)
        .where(sql`${table.status} <> 'archived'`),
    ],
  )
}

/**
 * Package-local Drizzle table for direct engine/worker DML against the host-owned physical table.
 *
 * The host-composed schema owns the real users foreign key. This package-local table intentionally
 * omits that declaration because @qiln/core does not own the host users table.
 */
export const capsuleBranchesTable = createCapsuleBranchesTable()
