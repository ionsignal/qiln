import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, timestamp, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { SshBranchAccessBlockReasonValues, SshBranchAccessStateValues } from '@qiln/core/server'

export const sshBranchAccessStateEnum = pgEnum('ssh_branch_access_state', SshBranchAccessStateValues)
export const sshBranchAccessBlockReasonEnum = pgEnum('ssh_branch_access_block_reason', SshBranchAccessBlockReasonValues)

/**
 * Host-owned per-branch SSH access fence.
 *
 * Newly created and forked branches must receive one explicit blocked row.
 * Enablement may update an existing blocked row only; Host policy must never
 * silently create an enabled fence.
 *
 * Branch ownership and capsule identity remain authoritative through the branch
 * relation rather than denormalized access-row columns.
 */
export function createAccessTable(branchId: PgColumn) {
  return pgTable(
    'ssh_branch_access',
    {
      branchId: uuid('branch_id')
        .primaryKey()
        .references(() => branchId, {
          onDelete: 'restrict',
        }),
      state: sshBranchAccessStateEnum('state').notNull().default('blocked'),
      blockReason: sshBranchAccessBlockReasonEnum('block_reason'),
      enabledAt: timestamp('enabled_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      blockedAt: timestamp('blocked_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp('updated_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
    },
    table => [
      index('ssh_branch_access_state_idx').on(table.state),
      check(
        'ssh_branch_access_state_check',
        sql`(
          (
            ${table.state} = 'enabled'
            AND ${table.blockReason} IS NULL
            AND ${table.enabledAt} IS NOT NULL
          )
          OR
          (
            ${table.state} = 'blocked'
            AND ${table.blockReason} IS NOT NULL
            AND ${table.blockedAt} IS NOT NULL
          )
        )`,
      ),
      check(
        'ssh_branch_access_timestamp_check',
        sql`(
          ${table.enabledAt} IS NULL
          OR ${table.enabledAt} >= ${table.createdAt}
        )
        AND
        (
          ${table.blockedAt} IS NULL
          OR ${table.blockedAt} >= ${table.createdAt}
        )`,
      ),
    ],
  )
}
