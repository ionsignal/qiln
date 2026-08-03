import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
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
  CapsuleRouteProviderStatusValues,
  CapsuleRouteProviderValues,
  type CapsuleRouteConfigurationDigest,
  type CapsuleRouteConfigurationKey,
  type CapsuleRouteVerificationEvidence,
} from '../../../schemas'

export const capsuleRouteProviderEnum = pgEnum('capsule_route_provider', CapsuleRouteProviderValues)
export const capsuleRouteProviderStatusEnum = pgEnum('capsule_route_provider_status', CapsuleRouteProviderStatusValues)

function createOperationIdColumn(operationIdColumn?: PgColumn) {
  return operationIdColumn
    ? uuid('operation_id')
        .primaryKey()
        .references(() => operationIdColumn, { onDelete: 'restrict' })
    : uuid('operation_id').primaryKey()
}

function createRevisionIdColumn(revisionIdColumn?: PgColumn) {
  return revisionIdColumn
    ? uuid('revision_id')
        .notNull()
        .references(() => revisionIdColumn, { onDelete: 'restrict' })
    : uuid('revision_id').notNull()
}

/**
 * Creates operation-scoped Caddy application accounting.
 *
 * These rows are derived-provider state, not committed route authority. The
 * alias head and committed revision remain authoritative.
 *
 * The composite operation/revision foreign key proves that provider accounting
 * belongs to the operation that created the proposed revision.
 *
 * Configuration identity may remain null while the row is `planned` or when an
 * operation fails before Caddy apply intent. Before any Caddy mutation, the
 * future provider repository must atomically persist the exact canonical
 * configuration, key, digest, and apply-intent timestamp.
 */
export function createCapsuleRouteProviderApplicationsTable(
  operationIdColumn?: PgColumn,
  revisionIdColumn?: PgColumn,
  revisionOperationIdColumn?: PgColumn,
) {
  const operationId = createOperationIdColumn(operationIdColumn)
  const revisionId = createRevisionIdColumn(revisionIdColumn)
  return pgTable(
    'capsule_route_provider_applications',
    {
      operationId,
      revisionId,
      provider: capsuleRouteProviderEnum('provider').notNull().default('caddy'),
      status: capsuleRouteProviderStatusEnum('status').notNull().default('planned'),
      configurationKey: text('configuration_key').$type<CapsuleRouteConfigurationKey>(),
      configurationDigest: text('configuration_digest').$type<CapsuleRouteConfigurationDigest>(),
      configuration: jsonb('configuration').$type<Record<string, unknown>>(),
      applyIntentAt: timestamp('apply_intent_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      appliedAt: timestamp('applied_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      verificationIntentAt: timestamp('verification_intent_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      verificationEvidence: jsonb('verification_evidence').$type<CapsuleRouteVerificationEvidence>(),
      verifiedAt: timestamp('verified_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      failureCode: text('failure_code'),
      failureMessage: text('failure_message'),
      failureDetails: jsonb('failure_details').$type<Record<string, unknown>>(),
      failureAt: timestamp('failure_at', {
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
      uniqueIndex('capsule_route_provider_applications_revision_unique_idx').on(table.revisionId),
      uniqueIndex('capsule_route_provider_applications_key_unique_idx')
        .on(table.provider, table.configurationKey)
        .where(sql`${table.configurationKey} IS NOT NULL`),
      index('capsule_route_provider_applications_status_idx').on(table.status),
      index('capsule_route_provider_applications_digest_idx').on(table.configurationDigest),
      ...(revisionOperationIdColumn && revisionIdColumn
        ? [
            foreignKey({
              columns: [table.operationId, table.revisionId],
              foreignColumns: [revisionOperationIdColumn, revisionIdColumn],
              name: 'capsule_route_provider_applications_operation_revision_fk',
            }).onDelete('restrict'),
          ]
        : []),
      check(
        'capsule_route_provider_applications_configuration_check',
        sql`(
          (
            ${table.configurationKey} IS NULL
            AND ${table.configurationDigest} IS NULL
            AND ${table.configuration} IS NULL
          )
          OR
          (
            ${table.configurationKey} IS NOT NULL
            AND ${table.configurationDigest} IS NOT NULL
            AND ${table.configuration} IS NOT NULL
          )
        )`,
      ),
      check(
        'capsule_route_provider_applications_configuration_digest_check',
        sql`(
          ${table.configurationDigest} IS NULL
          OR ${table.configurationDigest} ~ '^sha256:[a-f0-9]{64}$'
        )`,
      ),
      check(
        'capsule_route_provider_applications_mutation_check',
        sql`(
          ${table.status} IN ('planned', 'failed', 'cleanup_required')
          OR (
            ${table.configurationKey} IS NOT NULL
            AND ${table.configurationDigest} IS NOT NULL
            AND ${table.configuration} IS NOT NULL
          )
        )`,
      ),
      check(
        'capsule_route_provider_applications_timeline_check',
        sql`(
          (
            ${table.status} = 'planned'
            AND ${table.applyIntentAt} IS NULL
            AND ${table.appliedAt} IS NULL
            AND ${table.verificationIntentAt} IS NULL
            AND ${table.verificationEvidence} IS NULL
            AND ${table.verifiedAt} IS NULL
          )
          OR
          (
            ${table.status} = 'applying'
            AND ${table.applyIntentAt} IS NOT NULL
            AND ${table.appliedAt} IS NULL
            AND ${table.verificationIntentAt} IS NULL
            AND ${table.verificationEvidence} IS NULL
            AND ${table.verifiedAt} IS NULL
          )
          OR
          (
            ${table.status} = 'applied'
            AND ${table.applyIntentAt} IS NOT NULL
            AND ${table.appliedAt} IS NOT NULL
            AND ${table.verificationIntentAt} IS NULL
            AND ${table.verificationEvidence} IS NULL
            AND ${table.verifiedAt} IS NULL
          )
          OR
          (
            ${table.status} = 'verifying'
            AND ${table.applyIntentAt} IS NOT NULL
            AND ${table.appliedAt} IS NOT NULL
            AND ${table.verificationIntentAt} IS NOT NULL
            AND ${table.verificationEvidence} IS NULL
            AND ${table.verifiedAt} IS NULL
          )
          OR
          (
            ${table.status} = 'verified'
            AND ${table.applyIntentAt} IS NOT NULL
            AND ${table.appliedAt} IS NOT NULL
            AND ${table.verificationIntentAt} IS NOT NULL
            AND ${table.verificationEvidence} IS NOT NULL
            AND ${table.verifiedAt} IS NOT NULL
          )
          OR
          (
            ${table.status} IN ('failed', 'cleanup_required')
            AND ${table.failureAt} IS NOT NULL
          )
        )`,
      ),
      check(
        'capsule_route_provider_applications_failure_check',
        sql`(
          (
            ${table.status} IN ('failed', 'cleanup_required')
            AND ${table.failureCode} IS NOT NULL
            AND ${table.failureMessage} IS NOT NULL
            AND ${table.failureDetails} IS NOT NULL
            AND ${table.failureAt} IS NOT NULL
          )
          OR
          (
            ${table.status} NOT IN ('failed', 'cleanup_required')
            AND ${table.failureCode} IS NULL
            AND ${table.failureMessage} IS NULL
            AND ${table.failureDetails} IS NULL
            AND ${table.failureAt} IS NULL
          )
        )`,
      ),
      check(
        'capsule_route_provider_applications_timestamp_order_check',
        sql`(
          (
            ${table.appliedAt} IS NULL
            OR (
              ${table.applyIntentAt} IS NOT NULL
              AND ${table.appliedAt} >= ${table.applyIntentAt}
            )
          )
          AND
          (
            ${table.verificationIntentAt} IS NULL
            OR (
              ${table.appliedAt} IS NOT NULL
              AND ${table.verificationIntentAt} >= ${table.appliedAt}
            )
          )
          AND
          (
            ${table.verifiedAt} IS NULL
            OR (
              ${table.verificationIntentAt} IS NOT NULL
              AND ${table.verifiedAt} >= ${table.verificationIntentAt}
            )
          )
        )`,
      ),
    ],
  )
}
