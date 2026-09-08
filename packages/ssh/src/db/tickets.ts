import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { SshTicketStatusValues } from '@qiln/core/server'

export const sshTicketStatusEnum = pgEnum('ssh_ticket_status', SshTicketStatusValues)

interface TicketBindings {
  userId: PgColumn
  capsuleId: PgColumn
  branchId: PgColumn
  publicKeyId: PgColumn
  grantId: PgColumn
}

/**
 * Short-lived, single-use SSH gateway tickets.
 *
 * Only a SHA-256 hash of the opaque bearer ticket is persisted. Raw ticket
 * material, branch runtime destinations, private keys, and client-supplied
 * routing data have no persistence field.
 */
export function createTicketsTable(bindings: TicketBindings) {
  return pgTable(
    'ssh_tickets',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ticketHash: text('ticket_hash').notNull(),
      publicKeyId: uuid('public_key_id')
        .notNull()
        .references(() => bindings.publicKeyId, { onDelete: 'restrict' }),
      grantId: uuid('grant_id')
        .notNull()
        .references(() => bindings.grantId, { onDelete: 'restrict' }),
      userId: uuid('user_id')
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
      status: sshTicketStatusEnum('status').notNull().default('issued'),
      expiresAt: timestamp('expires_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }).notNull(),
      issuedAt: timestamp('issued_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
      redeemedAt: timestamp('redeemed_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      revokedAt: timestamp('revoked_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
    },
    table => [
      uniqueIndex('ssh_tickets_hash_unique_idx').on(table.ticketHash),
      index('ssh_tickets_key_idx').on(table.publicKeyId),
      index('ssh_tickets_grant_idx').on(table.grantId),
      index('ssh_tickets_user_idx').on(table.userId),
      index('ssh_tickets_capsule_idx').on(table.capsuleId),
      index('ssh_tickets_branch_status_idx').on(table.branchId, table.status),
      index('ssh_tickets_status_expiry_idx').on(table.status, table.expiresAt),
      check('ssh_tickets_hash_check', sql`${table.ticketHash} ~ '^sha256:[a-f0-9]{64}$'`),
      check('ssh_tickets_expiry_check', sql`${table.expiresAt} > ${table.issuedAt}`),
      check(
        'ssh_tickets_state_check',
        sql`(
          (
            ${table.status} = 'issued'
            AND ${table.redeemedAt} IS NULL
            AND ${table.revokedAt} IS NULL
          )
          OR
          (
            ${table.status} = 'redeemed'
            AND ${table.redeemedAt} IS NOT NULL
            AND ${table.revokedAt} IS NULL
          )
          OR
          (
            ${table.status} = 'revoked'
            AND ${table.revokedAt} IS NOT NULL
          )
        )`,
      ),
      check(
        'ssh_tickets_timestamp_check',
        sql`(
          ${table.redeemedAt} IS NULL
          OR ${table.redeemedAt} >= ${table.issuedAt}
        )
        AND
        (
          ${table.revokedAt} IS NULL
          OR ${table.revokedAt} >= ${table.issuedAt}
        )
        AND
        (
          ${table.redeemedAt} IS NULL
          OR ${table.revokedAt} IS NULL
          OR ${table.revokedAt} >= ${table.redeemedAt}
        )`,
      ),
    ],
  )
}
