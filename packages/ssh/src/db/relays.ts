import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { SshRelayStatusValues } from '@qiln/core/server'

export const sshRelayStatusEnum = pgEnum('ssh_relay_status', SshRelayStatusValues)

interface RelayBindings {
  userId: PgColumn
  capsuleId: PgColumn
  branchId: PgColumn
  publicKeyId: PgColumn
  ticketId: PgColumn
}

/**
 * Durable SSH relay audit and revocation-coordination state.
 *
 * Relay rows deliberately contain no branch runtime IP or port. Ticket
 * redemption and activation must derive the current exact private destination
 * through Host policy. One redeemed ticket can create at most one relay.
 */
export function createRelaysTable(bindings: RelayBindings) {
  return pgTable(
    'ssh_relays',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ticketId: uuid('ticket_id')
        .notNull()
        .references(() => bindings.ticketId, { onDelete: 'restrict' }),
      publicKeyId: uuid('public_key_id')
        .notNull()
        .references(() => bindings.publicKeyId, { onDelete: 'restrict' }),
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
      gatewayInstanceId: text('gateway_instance_id').notNull(),
      status: sshRelayStatusEnum('status').notNull().default('opening'),
      openedAt: timestamp('opened_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
      activatedAt: timestamp('activated_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      closingAt: timestamp('closing_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      closedAt: timestamp('closed_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      closureReason: text('closure_reason'),
    },
    table => [
      uniqueIndex('ssh_relays_ticket_unique_idx').on(table.ticketId),
      index('ssh_relays_key_idx').on(table.publicKeyId),
      index('ssh_relays_user_idx').on(table.userId),
      index('ssh_relays_capsule_idx').on(table.capsuleId),
      index('ssh_relays_branch_status_idx').on(table.branchId, table.status),
      index('ssh_relays_gateway_status_idx').on(table.gatewayInstanceId, table.status),
      check(
        'ssh_relays_gateway_instance_check',
        sql`(
          length(btrim(${table.gatewayInstanceId})) BETWEEN 1 AND 128
          AND ${table.gatewayInstanceId} = btrim(${table.gatewayInstanceId})
          AND ${table.gatewayInstanceId} !~ '[[:cntrl:]]'
        )`,
      ),
      check(
        'ssh_relays_closure_reason_check',
        sql`(
          ${table.closureReason} IS NULL
          OR (
            length(btrim(${table.closureReason})) BETWEEN 1 AND 128
            AND ${table.closureReason} = btrim(${table.closureReason})
            AND ${table.closureReason} !~ '[[:cntrl:]]'
          )
        )`,
      ),
      check(
        'ssh_relays_state_check',
        sql`(
          (
            ${table.status} = 'opening'
            AND ${table.activatedAt} IS NULL
            AND ${table.closingAt} IS NULL
            AND ${table.closedAt} IS NULL
            AND ${table.closureReason} IS NULL
          )
          OR
          (
            ${table.status} = 'active'
            AND ${table.activatedAt} IS NOT NULL
            AND ${table.closingAt} IS NULL
            AND ${table.closedAt} IS NULL
            AND ${table.closureReason} IS NULL
          )
          OR
          (
            ${table.status} = 'closing'
            AND ${table.closingAt} IS NOT NULL
            AND ${table.closedAt} IS NULL
            AND ${table.closureReason} IS NOT NULL
          )
          OR
          (
            ${table.status} = 'closed'
            AND ${table.closingAt} IS NOT NULL
            AND ${table.closedAt} IS NOT NULL
            AND ${table.closureReason} IS NOT NULL
          )
        )`,
      ),
      check(
        'ssh_relays_timestamp_check',
        sql`(
          ${table.activatedAt} IS NULL
          OR ${table.activatedAt} >= ${table.openedAt}
        )
        AND
        (
          ${table.closingAt} IS NULL
          OR ${table.closingAt} >= ${table.openedAt}
        )
        AND
        (
          ${table.closedAt} IS NULL
          OR (
            ${table.closingAt} IS NOT NULL
            AND ${table.closedAt} >= ${table.closingAt}
          )
        )`,
      ),
    ],
  )
}
