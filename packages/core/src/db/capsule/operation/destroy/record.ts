import { sql } from 'drizzle-orm'
import { check, integer, jsonb, pgTable, text, timestamp, uuid, type PgColumn } from 'drizzle-orm/pg-core'
import type { CapsuleDestroyDigest, SshCapsuleAccessRevocationOutput } from '../../../../schemas'

/**
 * Immutable plan identity for one destroy attempt.
 *
 * Force policy remains on the base operation. This extension binds the complete
 * branch scope and target set without rewriting historical create or fork
 * accounting. SSH evidence belongs to this attempt, not a predecessor.
 */
export function createCapsuleDestroyOperationsTable(operationIdColumn?: PgColumn) {
  const operationId = operationIdColumn
    ? uuid('operation_id')
        .primaryKey()
        .references(() => operationIdColumn, { onDelete: 'restrict' })
    : uuid('operation_id').primaryKey()
  return pgTable(
    'capsule_destroy_operations',
    {
      operationId,
      schemaVersion: integer('schema_version').notNull(),
      planDigest: text('plan_digest').$type<CapsuleDestroyDigest>().notNull(),
      branchIds: uuid('branch_ids').array().notNull(),
      targetCount: integer('target_count').notNull(),
      plannedAt: timestamp('planned_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
      sshRevocation: jsonb('ssh_revocation').$type<SshCapsuleAccessRevocationOutput>(),
      sshRevokedAt: timestamp('ssh_revoked_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
    },
    table => [
      check('capsule_destroy_operations_version_check', sql`${table.schemaVersion} = 1`),
      check('capsule_destroy_operations_digest_check', sql`${table.planDigest} ~ '^sha256:[a-f0-9]{64}$'`),
      check('capsule_destroy_operations_branches_check', sql`cardinality(${table.branchIds}) > 0`),
      check('capsule_destroy_operations_count_check', sql`${table.targetCount} >= 0`),
      check(
        'capsule_destroy_operations_ssh_check',
        sql`(
          (${table.sshRevocation} IS NULL AND ${table.sshRevokedAt} IS NULL)
          OR (
            ${table.sshRevocation} IS NOT NULL
            AND jsonb_typeof(${table.sshRevocation}) = 'object'
            AND ${table.sshRevokedAt} IS NOT NULL
            AND ${table.sshRevokedAt} >= ${table.plannedAt}
          )
        )`,
      ),
    ],
  )
}
