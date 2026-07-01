import { sql, type RelationsBuilder, type ExtractTablesWithRelations, type ExtractTablesFromSchema } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, pgEnum, index, uniqueIndex, type PgColumn, type AnyPgTable } from 'drizzle-orm/pg-core'
import { DEFAULT_CAPSULE_BLUEPRINT_NAME } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Enum to support capsule branch runtime states.
 */
export const instanceStatusEnum = pgEnum('instance_status', ['provisioning', 'offline', 'starting', 'online', 'stopping', 'archived', 'error'])

export function createHostSchema<TUserIdColumn extends PgColumn>(userIdColumn: TUserIdColumn) {
  const instances = pgTable(
    'instances',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId: uuid('owner_id')
        .notNull()
        .references(() => userIdColumn, { onDelete: 'cascade' }),
      ip: text('ip'),
      name: text('name').notNull(),
      cpu: text('cpu').notNull().default('4'),
      memory: text('memory').notNull().default('4GB'),
      definition: text('definition').notNull().default(DEFAULT_CAPSULE_BLUEPRINT_NAME),
      status: instanceStatusEnum('status').notNull().default('provisioning'),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    table => [index('instances_owner_idx').on(table.ownerId), uniqueIndex('instances_owner_name_unique_idx').on(table.ownerId, table.name)],
  )

  return { instances }
}

/**
 * A placeholder column used to instantiate the schema locally within the worker package.
 */
const dummyIdColumn = { name: 'id', getSQL: () => sql`id` } as unknown as PgColumn
export const librarySchema = createHostSchema(dummyIdColumn)

/**
 * Minimal Host Contract.
 */
export type HostUsersTable = AnyPgTable & { id: PgColumn }

/**
 * The Package Schema: worker tables + minimal host tables.
 */
export type PackageSchema = typeof librarySchema & { users: HostUsersTable }

/**
 * Defines the relational graph strictly for the package's internal use.
 */
export function defineHostRelations(helpers: RelationsBuilder<PackageSchema>) {
  return {
    instances: {
      owner: helpers.one.users({
        from: helpers.instances.ownerId,
        to: helpers.users.id,
      }),
    },
  }
}

/**
 * Internal helper to extract the exact return type of the relations definition.
 */
type PackageRelations = ReturnType<typeof defineHostRelations>

/**
 * The Database Contract.
 */
export type HostDbContract = PostgresJsDatabase<ExtractTablesWithRelations<PackageRelations, ExtractTablesFromSchema<PackageSchema>>>
