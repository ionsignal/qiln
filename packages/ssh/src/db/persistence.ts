import type { AnyPgColumn, PgTableWithColumns } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsuleTables } from '@qiln/core/server'
import type { SshTables } from './schema'

type UserIdColumn = AnyPgColumn<{
  dataType: 'string uuid'
  data: string
  driverParam: string
  notNull: true
}>

type UserAdminColumn = AnyPgColumn<{
  dataType: 'boolean'
  data: boolean
  driverParam: boolean
  notNull: true
}>

/**
 * Narrow structural view of the Host's existing user table.
 *
 * Policy needs only durable user identity and administrator state. This type
 * creates no table and does not expose Host authentication fields.
 */
export type SshUsersTable = PgTableWithColumns<{
  name: string
  schema: string | undefined
  columns: {
    id: UserIdColumn
    isAdmin: UserAdminColumn
  }
  dialect: 'pg'
}>

export type SshPersistenceTables = SshTables &
  Pick<CapsuleTables, 'capsules' | 'capsuleBranches'> & {
    users: SshUsersTable
  }

/**
 * Exact Host-composed database and table handles used by SSH policy.
 *
 * The package opens no database connection and constructs no parallel user or
 * capsule table instances. Relational queries remain a Host composition
 * concern; policy uses typed selections against the injected handles.
 */
export interface SshPersistence {
  readonly db: PostgresJsDatabase
  readonly tables: SshPersistenceTables
}

export type SshDatabaseTransaction = Parameters<Parameters<SshPersistence['db']['transaction']>[0]>[0]
