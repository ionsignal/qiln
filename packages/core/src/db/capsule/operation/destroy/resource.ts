import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgColumn,
} from 'drizzle-orm/pg-core'
import {
  CapsuleDestroyResourceStatusValues,
  type CapsuleDestroyDigest,
  type CapsuleDestroyObservation,
  type CapsuleDestroyProof,
  type CapsuleDestroyTarget,
} from '../../../../schemas'

export const capsuleDestroyResourceStatusEnum = pgEnum(
  'capsule_destroy_resource_status',
  CapsuleDestroyResourceStatusValues,
)

/**
 * One operation's deletion obligation and observations.
 *
 * Target and proof are immutable. Before and after observations are separate
 * so a configuration mismatch remains auditable after successful removal.
 * Historical branch-resource diagnostics are not cleared by these transitions.
 *
 * Unresolved may also represent abandonment without a new provider observation.
 */
export function createCapsuleDestroyResourcesTable(operationIdColumn?: PgColumn) {
  const operationId = operationIdColumn
    ? uuid('operation_id')
        .notNull()
        .references(() => operationIdColumn, { onDelete: 'restrict' })
    : uuid('operation_id').notNull()

  return pgTable(
    'capsule_destroy_resources',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      operationId,
      targetDigest: text('target_digest').$type<CapsuleDestroyDigest>().notNull(),
      target: jsonb('target').$type<CapsuleDestroyTarget>().notNull(),
      proof: jsonb('proof').$type<CapsuleDestroyProof>().notNull(),
      status: capsuleDestroyResourceStatusEnum('status').notNull().default('planned'),
      before: jsonb('observation_before').$type<CapsuleDestroyObservation>(),
      after: jsonb('observation_after').$type<CapsuleDestroyObservation>(),
      intentAt: timestamp('intent_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      verifiedAt: timestamp('verified_at', {
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
      index('capsule_destroy_resources_operation_idx').on(table.operationId),
      index('capsule_destroy_resources_status_idx').on(table.status),
      uniqueIndex('capsule_destroy_resources_operation_target_unique_idx').on(table.operationId, table.targetDigest),
      check('capsule_destroy_resources_digest_check', sql`${table.targetDigest} ~ '^sha256:[a-f0-9]{64}$'`),
      check(
        'capsule_destroy_resources_documents_check',
        sql`(
          jsonb_typeof(${table.target}) = 'object'
          AND jsonb_typeof(${table.proof}) = 'object'
          AND (${table.before} IS NULL OR jsonb_typeof(${table.before}) = 'object')
          AND (${table.after} IS NULL OR jsonb_typeof(${table.after}) = 'object')
        )`,
      ),
      check(
        'capsule_destroy_resources_state_check',
        sql`(
          (
            ${table.status} = 'planned'
            AND ${table.intentAt} IS NULL
            AND ${table.after} IS NULL
            AND ${table.verifiedAt} IS NULL
            AND (${table.before} IS NULL OR (${table.before}->>'state') IS NOT DISTINCT FROM 'present')
          )
          OR (
            ${table.status} = 'deleting'
            AND ${table.before} IS NOT NULL
            AND (${table.before}->>'state') IS NOT DISTINCT FROM 'present'
            AND ${table.intentAt} IS NOT NULL
            AND ${table.after} IS NULL
            AND ${table.verifiedAt} IS NULL
          )
          OR (
            ${table.status} = 'absent'
            AND ${table.before} IS NOT NULL
            AND (${table.before}->>'state') IS NOT DISTINCT FROM 'absent'
            AND ${table.intentAt} IS NULL
            AND ${table.after} IS NULL
            AND ${table.verifiedAt} IS NOT NULL
          )
          OR (
            ${table.status} = 'deleted'
            AND ${table.before} IS NOT NULL
            AND (${table.before}->>'state') IS NOT DISTINCT FROM 'present'
            AND ${table.intentAt} IS NOT NULL
            AND ${table.after} IS NOT NULL
            AND (${table.after}->>'state') IS NOT DISTINCT FROM 'absent'
            AND ${table.verifiedAt} IS NOT NULL
          )
          OR (
            ${table.status} = 'unresolved'
            AND ${table.verifiedAt} IS NULL
          )
        )`,
      ),
      check(
        'capsule_destroy_resources_timeline_check',
        sql`(
          (${table.intentAt} IS NULL OR ${table.intentAt} >= ${table.createdAt})
          AND (${table.after} IS NULL OR ${table.intentAt} IS NOT NULL)
          AND (
            ${table.verifiedAt} IS NULL
            OR ${table.verifiedAt} >= COALESCE(${table.intentAt}, ${table.createdAt})
          )
        )`,
      ),
    ],
  )
}
