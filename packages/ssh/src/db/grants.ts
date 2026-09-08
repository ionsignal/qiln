import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, timestamp, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { SshBranchGrantStatusValues } from '@qiln/core/server'

export const sshBranchGrantStatusEnum = pgEnum('ssh_branch_grant_status', SshBranchGrantStatusValues)

interface GrantBindings {
  userId: PgColumn
  capsuleId: PgColumn
  branchId: PgColumn
  publicKeyId: PgColumn
}

/**
 * Admin-created binding between one registered SSH key and one editable branch.
 *
 * Key-owner, capsule-owner, capsule, and binding-admin columns are immutable
 * audit evidence. Host policy must transactionally prove that they still agree
 * with the current key and branch relations before ticket issue or redemption.
 */
export function createGrantsTable(bindings: GrantBindings) {
  return pgTable(
    'ssh_branch_grants',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      publicKeyId: uuid('public_key_id')
        .notNull()
        .references(() => bindings.publicKeyId, { onDelete: 'restrict' }),
      keyOwnerUserId: uuid('key_owner_user_id')
        .notNull()
        .references(() => bindings.userId, { onDelete: 'restrict' }),
      capsuleOwnerUserId: uuid('capsule_owner_user_id')
        .notNull()
        .references(() => bindings.userId, { onDelete: 'restrict' }),
      capsuleId: uuid('capsule_id')
        .notNull()
        .references(() => bindings.capsuleId, { onDelete: 'restrict' }),
      branchId: uuid('branch_id')
        .notNull()
        .references(() => bindings.branchId, {
          onDelete: 'restrict',
        }),
      boundByAdminUserId: uuid('bound_by_admin_user_id')
        .notNull()
        .references(() => bindings.userId, { onDelete: 'restrict' }),
      revokedByUserId: uuid('revoked_by_user_id').references(() => bindings.userId, {
        onDelete: 'restrict',
      }),
      status: sshBranchGrantStatusEnum('status').notNull().default('active'),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
      revokedAt: timestamp('revoked_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
    },
    table => [
      index('ssh_branch_grants_key_owner_idx').on(table.keyOwnerUserId),
      index('ssh_branch_grants_capsule_owner_idx').on(table.capsuleOwnerUserId),
      index('ssh_branch_grants_capsule_idx').on(table.capsuleId),
      index('ssh_branch_grants_branch_idx').on(table.branchId),
      index('ssh_branch_grants_admin_idx').on(table.boundByAdminUserId),
      index('ssh_branch_grants_status_idx').on(table.status),
      uniqueIndex('ssh_branch_grants_active_key_unique_idx')
        .on(table.publicKeyId)
        .where(sql`${table.status} = 'active'`),
      uniqueIndex('ssh_branch_grants_active_key_branch_unique_idx')
        .on(table.publicKeyId, table.branchId)
        .where(sql`${table.status} = 'active'`),
      check(
        'ssh_branch_grants_state_check',
        sql`(
          (
            ${table.status} = 'active'
            AND ${table.revokedAt} IS NULL
            AND ${table.revokedByUserId} IS NULL
          )
          OR
          (
            ${table.status} = 'revoked'
            AND ${table.revokedAt} IS NOT NULL
          )
        )`,
      ),
      check(
        'ssh_branch_grants_timestamp_check',
        sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
      ),
    ],
  )
}
