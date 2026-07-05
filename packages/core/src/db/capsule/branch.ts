import { sql, type RelationsBuilder, type ExtractTablesWithRelations, type ExtractTablesFromSchema } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, pgEnum, index, uniqueIndex, type PgColumn, type AnyPgTable } from 'drizzle-orm/pg-core'
import { CapsuleBranchStatusValues, DEFAULT_CAPSULE_BLUEPRINT_NAME } from '../../protocol/capsule/messages'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Canonical database enum for capsule branch runtime state.
 *
 * The values are imported from the capsule protocol so Postgres, tRPC output,
 * realtime events, and worker command handling remain aligned.
 */
export const capsuleBranchStatusEnum = pgEnum('capsule_branch_status', CapsuleBranchStatusValues)

/**
 * Defines the capsule branch read-model tables that must be composed into a host schema.
 *
 * `capsule_branches` is intentionally only the branch read model. A first-class
 * durable `capsules` table will come later with snapshot/version/route-alias
 * semantics; this task only renames the existing branch persistence boundary.
 */
export function createCapsuleBranchSchema<TUserIdColumn extends PgColumn>(userIdColumn: TUserIdColumn) {
  const capsuleBranches = pgTable(
    'capsule_branches',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId: uuid('owner_id')
        .notNull()
        .references(() => userIdColumn, { onDelete: 'cascade' }),
      runtimeIp: text('runtime_ip'),
      name: text('name').notNull(),
      cpu: text('cpu').notNull().default('4'),
      memory: text('memory').notNull().default('4GB'),
      blueprintName: text('blueprint_name').notNull().default(DEFAULT_CAPSULE_BLUEPRINT_NAME),
      status: capsuleBranchStatusEnum('status').notNull().default('provisioning'),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    table => [
      index('capsule_branches_owner_idx').on(table.ownerId),
      uniqueIndex('capsule_branches_owner_name_unique_idx').on(table.ownerId, table.name),
    ],
  )

  return { capsuleBranches }
}

/**
 * A placeholder column used to instantiate the schema locally within packages
 * that need a typed DB contract without owning the host users table.
 */
const dummyIdColumn = { name: 'id', getSQL: () => sql`id` } as unknown as PgColumn
export const capsuleBranchLibrarySchema = createCapsuleBranchSchema(dummyIdColumn)

/**
 * Minimal host user-table shape required by the capsule branch schema.
 */
export type CapsuleBranchHostUsersTable = AnyPgTable & { id: PgColumn }

/**
 * Package schema used for relation and database contract extraction.
 */
export type CapsuleBranchPackageSchema = typeof capsuleBranchLibrarySchema & { users: CapsuleBranchHostUsersTable }

/**
 * Defines the relation graph owned by the capsule branch read model.
 */
export function defineCapsuleBranchRelations(helpers: RelationsBuilder<CapsuleBranchPackageSchema>) {
  return {
    capsuleBranches: {
      owner: helpers.one.users({
        from: helpers.capsuleBranches.ownerId,
        to: helpers.users.id,
      }),
    },
  }
}

type CapsuleBranchPackageRelations = ReturnType<typeof defineCapsuleBranchRelations>

/**
 * Database contract expected by server-side consumers that use the capsule branch read model.
 */
export type CapsuleBranchHostDbContract = PostgresJsDatabase<
  ExtractTablesWithRelations<CapsuleBranchPackageRelations, ExtractTablesFromSchema<CapsuleBranchPackageSchema>>
>
