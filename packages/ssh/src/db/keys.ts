import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import { SshPublicKeyAlgorithmValues, SshPublicKeyStatusValues } from '@qiln/core/server'

export const sshPublicKeyAlgorithmEnum = pgEnum('ssh_public_key_algorithm', SshPublicKeyAlgorithmValues)
export const sshPublicKeyStatusEnum = pgEnum('ssh_public_key_status', SshPublicKeyStatusValues)

/**
 * Host-owned canonical SSH public-key registrations.
 *
 * The complete canonical public-key blob is the durable identity and is unique.
 * The OpenSSH SHA-256 fingerprint is indexed for lookup and display, but is not
 * sufficient authorization without an exact canonical algorithm and blob
 * comparison.
 */
export function createKeysTable(userId: PgColumn) {
  return pgTable(
    'ssh_public_keys',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerUserId: uuid('owner_user_id')
        .notNull()
        .references(() => userId, { onDelete: 'restrict' }),
      algorithm: sshPublicKeyAlgorithmEnum('algorithm').notNull(),
      publicKeyBlob: text('public_key_blob').notNull(),
      fingerprint: text('fingerprint').notNull(),
      label: text('label'),
      status: sshPublicKeyStatusEnum('status').notNull().default('active'),
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
      uniqueIndex('ssh_public_keys_blob_unique_idx').on(table.publicKeyBlob),
      index('ssh_public_keys_owner_status_idx').on(table.ownerUserId, table.status),
      index('ssh_public_keys_fingerprint_idx').on(table.fingerprint),
      check(
        'ssh_public_keys_state_check',
        sql`(
          (
            ${table.status} = 'active'
            AND ${table.revokedAt} IS NULL
          )
          OR
          (
            ${table.status} = 'revoked'
            AND ${table.revokedAt} IS NOT NULL
          )
        )`,
      ),
      check('ssh_public_keys_fingerprint_check', sql`${table.fingerprint} ~ '^SHA256:[A-Za-z0-9+/]{43}$'`),
      check('ssh_public_keys_blob_check', sql`length(${table.publicKeyBlob}) BETWEEN 1 AND 16384`),
      check(
        'ssh_public_keys_label_check',
        sql`(
          ${table.label} IS NULL
          OR (
            length(btrim(${table.label})) BETWEEN 1 AND 128
            AND ${table.label} = btrim(${table.label})
            AND ${table.label} !~ '[[:cntrl:]]'
          )
        )`,
      ),
    ],
  )
}
