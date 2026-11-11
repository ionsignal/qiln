import { sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { createDatabase } from '@server/db'
import { loadEnvironmentConfig } from '@server/env'
import { capsuleBranches, capsuleOperations, capsules } from '@/db/capsule'
import { sshBranchAccess, sshBranchGrants, sshPublicKeys, sshRelays, sshTickets } from '@/db/ssh'
import { users } from '@/db/users'
import type { SQL } from 'drizzle-orm'
import type { AnyPgTable } from 'drizzle-orm/pg-core'

const role = sql.identifier('qiln-ssh')
const database = sql.identifier('qiln')
const schemaName = 'public'

type TableColumn<TTable extends AnyPgTable> = TTable['_']['columns'][keyof TTable['_']['columns']]
type ColumnList<TTable extends AnyPgTable> = readonly [TableColumn<TTable>, ...TableColumn<TTable>[]]

/**
 * Privileges for one table. Columns are typed against the table itself, so a
 * column of a sibling table fails to compile instead of silently resolving to
 * the same physical name.
 *
 * Reads and inserts are table-wide because Drizzle names every column in an
 * INSERT. Updates are limited to lifecycle columns, which keeps identity and
 * audit columns immutable. DELETE is never granted.
 *
 * `lock` is not a write. PostgreSQL requires UPDATE on at least one column of
 * every table a locking read (`FOR UPDATE`, `FOR SHARE`) touches, so tables SSH
 * only locks receive one low-value column that SSH never writes.
 */
interface TablePrivileges<TTable extends AnyPgTable> {
  table: TTable
  select: 'all' | ColumnList<TTable>
  insert?: true
  update: { write: ColumnList<TTable> } | { lock: TableColumn<TTable> }
}

function columnList(columns: readonly { name: string }[]) {
  return sql.join(
    columns.map(column => sql.identifier(column.name)),
    sql`, `,
  )
}

function tableGrants<TTable extends AnyPgTable>({ table, select, insert, update }: TablePrivileges<TTable>): SQL[] {
  const { name, schema } = getTableConfig(table)
  const target = sql`${sql.identifier(schema ?? schemaName)}.${sql.identifier(name)}`
  const grant = (privilege: SQL) => sql`GRANT ${privilege} ON ${target} TO ${role}`
  const updateColumns = 'write' in update ? update.write : [update.lock]
  return [
    grant(select === 'all' ? sql`SELECT` : sql`SELECT (${columnList(select)})`),
    ...(insert ? [grant(sql`INSERT`)] : []),
    grant(sql`UPDATE (${columnList(updateColumns)})`),
  ]
}

/**
 * Complete privilege set of the standalone SSH authority (PostgreSQL role
 * "qiln-ssh", created by the image's qiln-postgres-bootstrap). Run it with
 * `npm run db:grant` after every migration or schema reset. The REVOKE makes
 * each run converge on exactly this set, and the single transaction rolls back
 * if any statement fails.
 *
 * Foreign-key checks run as the table owner and need no grant. Schema USAGE
 * comes from the PostgreSQL 15+ default on PUBLIC, and CREATE is not granted.
 * Nothing here grants TRUNCATE, sequence or function privileges, reads of
 * users.password, sessions, or agent_credentials, or any write to identity or
 * audit columns.
 *
 * The matrix lives in the application because the role is deployment identity,
 * not package policy. The runner connects as the table owner "qiln" through the
 * Host configuration. It is compiled apart from the Web project, which must not
 * import SSH composition, and needs the package declarations `build:server`
 * needs plus `packages/ssh/dist`.
 */
const statements = [
  sql`REVOKE ALL ON ALL TABLES IN SCHEMA ${sql.identifier(schemaName)} FROM ${role}`,
  sql`GRANT CONNECT ON DATABASE ${database} TO ${role}`,

  // Host identity: SSH policy reads identity and administrator state only.
  ...tableGrants({ table: users, select: [users.id, users.isAdmin], update: { lock: users.avatar } }),

  // Capsule state is read and row-locked, never written.
  ...tableGrants({ table: capsules, select: 'all', update: { lock: capsules.updatedAt } }),
  ...tableGrants({ table: capsuleBranches, select: 'all', update: { lock: capsuleBranches.updatedAt } }),
  ...tableGrants({ table: capsuleOperations, select: 'all', update: { lock: capsuleOperations.updatedAt } }),

  // SSH-owned tables.
  ...tableGrants({
    table: sshPublicKeys,
    select: 'all',
    insert: true,
    update: { write: [sshPublicKeys.status, sshPublicKeys.revokedAt] },
  }),
  ...tableGrants({
    table: sshBranchAccess,
    select: 'all',
    insert: true,
    update: {
      write: [
        sshBranchAccess.state,
        sshBranchAccess.blockReason,
        sshBranchAccess.enabledAt,
        sshBranchAccess.blockedAt,
        sshBranchAccess.updatedAt,
      ],
    },
  }),
  ...tableGrants({
    table: sshBranchGrants,
    select: 'all',
    insert: true,
    update: { write: [sshBranchGrants.status, sshBranchGrants.revokedByUserId, sshBranchGrants.revokedAt] },
  }),
  ...tableGrants({
    table: sshTickets,
    select: 'all',
    insert: true,
    update: { write: [sshTickets.status, sshTickets.redeemedAt, sshTickets.revokedAt] },
  }),
  ...tableGrants({
    table: sshRelays,
    select: 'all',
    insert: true,
    update: {
      write: [
        sshRelays.status,
        sshRelays.activatedAt,
        sshRelays.closingAt,
        sshRelays.closedAt,
        sshRelays.closureReason,
      ],
    },
  }),
]

console.log('[Grants] Loading configuration...')
const config = await loadEnvironmentConfig()
const { db, close } = createDatabase(config.database.url, { queries: false })
try {
  console.log(`[Grants] Applying ${statements.length} statements in one transaction...`)
  await db.transaction(async tx => {
    for (const statement of statements) {
      await tx.execute(statement)
    }
  })
  console.log('[Grants] SSH role privileges applied.')
} catch (error) {
  console.error('[Grants] Failed to apply SSH role privileges:', error)
  process.exitCode = 1
} finally {
  await close()
}
