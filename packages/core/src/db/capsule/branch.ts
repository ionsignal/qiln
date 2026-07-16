import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { CapsuleBranchStatusValues, DEFAULT_CAPSULE_BLUEPRINT_NAME, type CapsuleBranchResourceInventoryDigest } from '../../schemas'
import { capsulesTable } from './capsule'

/**
 * Canonical database enum for capsule branch runtime state.
 *
 * Logical capsule archive state is not represented here. A branch remains
 * offline while its capsule is archived. Destroying and destroyed represent
 * terminal capsule-level provider retirement flow.
 */
export const capsuleBranchStatusEnum = pgEnum('capsule_branch_status', CapsuleBranchStatusValues)

function createOwnerIdColumn(ownerIdColumn?: PgColumn) {
  return ownerIdColumn
    ? uuid('owner_id')
        .notNull()
        .references(() => ownerIdColumn, { onDelete: 'cascade' })
    : uuid('owner_id').notNull()
}

function createCapsuleIdColumn(capsuleIdColumn?: PgColumn) {
  return capsuleIdColumn
    ? uuid('capsule_id')
        .notNull()
        .references(() => capsuleIdColumn, { onDelete: 'cascade' })
    : uuid('capsule_id').notNull()
}

/**
 * Creates the physical `capsule_branches` table.
 *
 * Transitional runtime statuses are durable mutation fences. Runtime error
 * fields preserve why Qiln could not prove a stable provider state.
 */
export function createCapsuleBranchesTable(ownerIdColumn?: PgColumn, capsuleIdColumn?: PgColumn) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const capsuleId = createCapsuleIdColumn(capsuleIdColumn)
  return pgTable(
    'capsule_branches',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      capsuleId,
      runtimeIp: text('runtime_ip'),
      runtimeErrorCode: text('runtime_error_code'),
      runtimeErrorMessage: text('runtime_error_message'),
      runtimeErrorDetails: jsonb('runtime_error_details').$type<Record<string, unknown>>(),
      runtimeErrorAt: timestamp('runtime_error_at', {
        withTimezone: true,
        mode: 'date',
      }),
      name: text('name').notNull(),
      cpu: text('cpu').notNull().default('4'),
      memory: text('memory').notNull().default('4GB'),
      blueprintName: text('blueprint_name').notNull().default(DEFAULT_CAPSULE_BLUEPRINT_NAME),
      blueprintDigest: text('blueprint_digest').notNull(),
      resourceInventoryDigest: text('resource_inventory_digest').$type<CapsuleBranchResourceInventoryDigest>(),
      status: capsuleBranchStatusEnum('status').notNull().default('provisioning'),
      isRootBranch: boolean('is_root_branch').notNull().default(false),
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
      index('capsule_branches_owner_idx').on(table.ownerId),
      index('capsule_branches_capsule_idx').on(table.capsuleId),
      index('capsule_branches_runtime_status_idx').on(table.status),
      index('capsule_branches_owner_runtime_status_idx').on(table.ownerId, table.status),
      uniqueIndex('capsule_branches_owner_runtime_name_unique_idx')
        .on(table.ownerId, table.name)
        .where(sql`${table.status} <> 'destroyed'`),
      uniqueIndex('capsule_branches_capsule_root_unique_idx')
        .on(table.capsuleId)
        .where(sql`${table.isRootBranch} = true`),
      check(
        'capsule_branches_runtime_error_details_check',
        sql`(
          ${table.status} <> 'error'
          OR (
            ${table.runtimeErrorCode} IS NOT NULL
            AND ${table.runtimeErrorMessage} IS NOT NULL
            AND ${table.runtimeErrorDetails} IS NOT NULL
            AND ${table.runtimeErrorAt} IS NOT NULL
          )
        )`,
      ),
      check(
        'capsule_branches_offline_runtime_ip_check',
        sql`(
          ${table.status} <> 'offline'
          OR ${table.runtimeIp} IS NULL
        )`,
      ),
    ],
  )
}

/**
 * Package-local Drizzle table for direct Core and Worker DML.
 *
 * The host-composed schema owns the users foreign key.
 */
export const capsuleBranchesTable = createCapsuleBranchesTable(undefined, capsulesTable.id)
