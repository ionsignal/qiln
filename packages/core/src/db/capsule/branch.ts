import { sql, type ExtractTablesFromSchema, type ExtractTablesWithRelations, type RelationsBuilderColumnBase } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, pgEnum, index, uniqueIndex, type AnyPgTable, type PgColumn } from 'drizzle-orm/pg-core'
import { CapsuleBranchStatusValues, DEFAULT_CAPSULE_BLUEPRINT_NAME } from '../../protocol/capsule/messages'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { RelationFragmentOneFn } from '../relations'

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
      status: capsuleBranchStatusEnum('status').notNull().default('provisioning'),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    table => [
      index('capsule_branches_owner_idx').on(table.ownerId),
      uniqueIndex('capsule_branches_owner_name_unique_idx').on(table.ownerId, table.name),
    ],
  )
}

/**
 * Defines the capsule branch read-model tables that must be composed into a host schema.
 *
 * This `capsule_branches` is intentionally only the branch read model. A first-class durable `capsules`
 * table will come later with snapshot/version/route-alias semantics; this task only renames the
 * existing branch persistence boundary.
 */
export function createCapsuleBranchSchema<TUserIdColumn extends PgColumn>(userIdColumn: TUserIdColumn) {
  return {
    capsuleBranches: createCapsuleBranchesTable(userIdColumn),
  }
}

/**
 * Package-local Drizzle table for direct engine/worker DML against the host-owned physical table. This
 * intentionally has no FK declaration because packages do not own the host `users` table; the real FK
 * remains in the host-composed schema.
 */
export const capsuleBranchesTable = createCapsuleBranchesTable()

/**
 * Minimal package schema for capsule branch consumers that need typed relational
 * queries without pretending to own the host user table.
 */
export const capsuleBranchRuntimeSchema = {
  capsuleBranches: capsuleBranchesTable,
} as const

/**
 * Compatibility alias retained for older call sites while removing the fake
 * PgColumn dependency that previously backed this symbol.
 */
export const capsuleBranchLibrarySchema = capsuleBranchRuntimeSchema

/**
 * Drizzle relation helpers read column availability from the table's internal
 * `_["columns"]` metadata, not just top-level table properties. This type keeps
 * that internal-column requirement explicit while preserving top-level column
 * access for compatibility with real `pgTable(...)` results.
 */
type PgTableWithInternalColumns<TColumns extends Record<string, PgColumn>> = AnyPgTable<{ columns: TColumns }> & TColumns

/**
 * Minimal host user-table shape required by the capsule branch relation fragment.
 */
export type CapsuleBranchHostUsersTable = PgTableWithInternalColumns<{
  id: PgColumn
}>

/**
 * Package-local capsule branch table shape for runtime DML/query contracts.
 */
export type CapsuleBranchTable = typeof capsuleBranchesTable

/**
 * Package schema retained for relation and database contract extraction.
 */
export type CapsuleBranchPackageSchema = typeof capsuleBranchRuntimeSchema & {
  users: CapsuleBranchHostUsersTable
}

/**
 * Narrow helper surface required by the capsule branch relation fragment.
 */
export interface CapsuleBranchRelationHelpers {
  one: {
    users: RelationFragmentOneFn<'users'>
  }
  users: {
    id: RelationsBuilderColumnBase<'users'>
  }
  capsuleBranches: {
    ownerId: RelationsBuilderColumnBase<'capsuleBranches'>
  }
}

/**
 * Defines the relation graph owned by the capsule branch read model.
 */
export function defineCapsuleBranchRelations(helpers: CapsuleBranchRelationHelpers) {
  return {
    capsuleBranches: {
      owner: helpers.one.users({
        from: helpers.capsuleBranches.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
    },
  }
}

type CapsuleBranchRuntimeRelations = ExtractTablesWithRelations<{}, ExtractTablesFromSchema<typeof capsuleBranchRuntimeSchema>>

/**
 * Database contract expected by server-side consumers that use the capsule branch read model.
 *
 * The contract intentionally models only the capsule branch query surface needed by engine/worker
 * packages. The host remains free to compose additional tables and relations into its final
 * Drizzle database.
 */
export type CapsuleBranchHostDbContract = PostgresJsDatabase<CapsuleBranchRuntimeRelations>
