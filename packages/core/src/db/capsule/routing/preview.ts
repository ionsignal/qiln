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
  CapsuleBranchPreviewStatusValues,
  type CapsuleBlueprintIdentifier,
  type CapsuleBranchPreviewRouteId,
  type CapsuleRouteApplicationPin,
  type CapsuleRouteConfigurationDigest,
  type CapsuleRouteConfigurationKey,
  type CapsuleRouteVerificationEvidence,
} from '../../../schemas'

export const capsuleBranchPreviewStatusEnum = pgEnum('capsule_branch_preview_status', CapsuleBranchPreviewStatusValues)

function createOwnerIdColumn(ownerIdColumn?: PgColumn) {
  return ownerIdColumn
    ? uuid('owner_id')
        .notNull()
        .references(() => ownerIdColumn, { onDelete: 'cascade' })
    : uuid('owner_id').notNull()
}

function createCapsuleIdColumn(capsuleIdColumn?: PgColumn) {
  return capsuleIdColumn
    ? uuid('capsule_id')
        .notNull()
        .references(() => capsuleIdColumn, { onDelete: 'cascade' })
    : uuid('capsule_id').notNull()
}

function createBranchIdColumn(branchIdColumn?: PgColumn) {
  return branchIdColumn
    ? uuid('branch_id')
        .notNull()
        .references(() => branchIdColumn, { onDelete: 'restrict' })
    : uuid('branch_id').notNull()
}

/**
 * Creates mutable branch-preview route state.
 *
 * Current configuration records the Caddy route Qiln has positively observed.
 * Pending configuration records a new intended mutation until Caddy readback
 * proves it became current. Keeping both prevents a failed or interrupted
 * replacement from erasing authority over an already-active preview route.
 *
 * Preview routes are derived ingress for editable branches. They are separate
 * from committed route aliases and revisions because they never authorize
 * promotion, rollback, or immutable route history.
 */
export function createCapsuleBranchPreviewsTable(
  ownerIdColumn?: PgColumn,
  capsuleIdColumn?: PgColumn,
  branchIdColumn?: PgColumn,
) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const capsuleId = createCapsuleIdColumn(capsuleIdColumn)
  const branchId = createBranchIdColumn(branchIdColumn)
  return pgTable(
    'capsule_branch_previews',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      capsuleId,
      branchId,
      applicationName: text('application_name').$type<CapsuleBlueprintIdentifier>().notNull(),
      applicationPin: jsonb('application_pin').$type<CapsuleRouteApplicationPin>().notNull(),
      host: text('host').notNull(),
      providerRouteId: text('provider_route_id').$type<CapsuleBranchPreviewRouteId>().notNull(),
      status: capsuleBranchPreviewStatusEnum('status').notNull().default('inactive'),
      withdrawalRequestedAt: timestamp('withdrawal_requested_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      }),
      currentRuntimeIp: text('current_runtime_ip'),
      currentConfigurationKey: text('current_configuration_key').$type<CapsuleRouteConfigurationKey>(),
      currentConfigurationDigest: text('current_configuration_digest').$type<CapsuleRouteConfigurationDigest>(),
      currentConfiguration: jsonb('current_configuration').$type<Record<string, unknown>>(),
      pendingRuntimeIp: text('pending_runtime_ip'),
      pendingConfigurationKey: text('pending_configuration_key').$type<CapsuleRouteConfigurationKey>(),
      pendingConfigurationDigest: text('pending_configuration_digest').$type<CapsuleRouteConfigurationDigest>(),
      pendingConfiguration: jsonb('pending_configuration').$type<Record<string, unknown>>(),
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
      removeIntentAt: timestamp('remove_intent_at', {
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
      index('capsule_branch_previews_owner_idx').on(table.ownerId),
      index('capsule_branch_previews_capsule_idx').on(table.capsuleId),
      index('capsule_branch_previews_branch_idx').on(table.branchId),
      index('capsule_branch_previews_status_idx').on(table.status),
      index('capsule_branch_previews_withdrawal_requested_idx').on(table.withdrawalRequestedAt),
      index('capsule_branch_previews_current_configuration_digest_idx').on(table.currentConfigurationDigest),
      index('capsule_branch_previews_pending_configuration_digest_idx').on(table.pendingConfigurationDigest),
      uniqueIndex('capsule_branch_previews_branch_application_unique_idx').on(table.branchId, table.applicationName),
      uniqueIndex('capsule_branch_previews_host_unique_idx').on(table.host),
      uniqueIndex('capsule_branch_previews_provider_route_id_unique_idx').on(table.providerRouteId),
      check(
        'capsule_branch_previews_host_check',
        sql`(
          length(${table.host}) BETWEEN 3 AND 253
          AND ${table.host} = lower(${table.host})
          AND ${table.host} !~ '[*><@/?#]'
          AND ${table.host} !~ '\\.$'
        )`,
      ),
      check(
        'capsule_branch_previews_provider_route_id_check',
        sql`${table.providerRouteId} ~ '^qiln-preview-[a-z0-9](?:[a-z0-9-]{0,113}[a-z0-9])?$'`,
      ),
      check(
        'capsule_branch_previews_current_configuration_check',
        sql`(
          (
            ${table.currentRuntimeIp} IS NULL
            AND ${table.currentConfigurationKey} IS NULL
            AND ${table.currentConfigurationDigest} IS NULL
            AND ${table.currentConfiguration} IS NULL
            AND ${table.appliedAt} IS NULL
          )
          OR
          (
            ${table.currentRuntimeIp} IS NOT NULL
            AND ${table.currentConfigurationKey} IS NOT NULL
            AND ${table.currentConfigurationDigest} IS NOT NULL
            AND ${table.currentConfiguration} IS NOT NULL
            AND jsonb_typeof(${table.currentConfiguration}) = 'object'
            AND ${table.appliedAt} IS NOT NULL
          )
        )`,
      ),
      check(
        'capsule_branch_previews_pending_configuration_check',
        sql`(
          (
            ${table.pendingRuntimeIp} IS NULL
            AND ${table.pendingConfigurationKey} IS NULL
            AND ${table.pendingConfigurationDigest} IS NULL
            AND ${table.pendingConfiguration} IS NULL
            AND ${table.applyIntentAt} IS NULL
          )
          OR
          (
            ${table.pendingRuntimeIp} IS NOT NULL
            AND ${table.pendingConfigurationKey} IS NOT NULL
            AND ${table.pendingConfigurationDigest} IS NOT NULL
            AND ${table.pendingConfiguration} IS NOT NULL
            AND jsonb_typeof(${table.pendingConfiguration}) = 'object'
            AND ${table.applyIntentAt} IS NOT NULL
          )
        )`,
      ),
      check(
        'capsule_branch_previews_current_runtime_ip_check',
        sql`${table.currentRuntimeIp} IS NULL OR length(btrim(${table.currentRuntimeIp})) BETWEEN 1 AND 255`,
      ),
      check(
        'capsule_branch_previews_pending_runtime_ip_check',
        sql`${table.pendingRuntimeIp} IS NULL OR length(btrim(${table.pendingRuntimeIp})) BETWEEN 1 AND 255`,
      ),
      check(
        'capsule_branch_previews_current_configuration_digest_check',
        sql`(
          ${table.currentConfigurationDigest} IS NULL
          OR ${table.currentConfigurationDigest} ~ '^sha256:[a-f0-9]{64}$'
        )`,
      ),
      check(
        'capsule_branch_previews_pending_configuration_digest_check',
        sql`(
          ${table.pendingConfigurationDigest} IS NULL
          OR ${table.pendingConfigurationDigest} ~ '^sha256:[a-f0-9]{64}$'
        )`,
      ),
      check(
        'capsule_branch_previews_verification_check',
        sql`(
          (
            ${table.verificationIntentAt} IS NULL
            AND ${table.verificationEvidence} IS NULL
            AND ${table.verifiedAt} IS NULL
          )
          OR
          (
            ${table.currentRuntimeIp} IS NOT NULL
            AND ${table.verificationIntentAt} IS NOT NULL
            AND ${table.verificationEvidence} IS NULL
            AND ${table.verifiedAt} IS NULL
          )
          OR
          (
            ${table.currentRuntimeIp} IS NOT NULL
            AND ${table.verificationIntentAt} IS NOT NULL
            AND ${table.verificationEvidence} IS NOT NULL
            AND ${table.verifiedAt} IS NOT NULL
          )
        )`,
      ),
      check(
        'capsule_branch_previews_remove_intent_check',
        sql`(
          ${table.removeIntentAt} IS NULL
          OR (
            ${table.currentRuntimeIp} IS NOT NULL
            AND ${table.pendingRuntimeIp} IS NULL
          )
        )`,
      ),
      check(
        'capsule_branch_previews_status_check',
        sql`(
          (
            ${table.status} = 'inactive'
            AND ${table.currentRuntimeIp} IS NULL
            AND ${table.pendingRuntimeIp} IS NULL
            AND ${table.verificationIntentAt} IS NULL
            AND ${table.verificationEvidence} IS NULL
            AND ${table.verifiedAt} IS NULL
            AND ${table.removeIntentAt} IS NULL
          )
          OR
          (
            ${table.status} = 'applying'
            AND ${table.pendingRuntimeIp} IS NOT NULL
            AND ${table.removeIntentAt} IS NULL
          )
          OR
          (
            ${table.status} = 'verifying'
            AND ${table.currentRuntimeIp} IS NOT NULL
            AND ${table.pendingRuntimeIp} IS NULL
            AND ${table.verificationIntentAt} IS NOT NULL
            AND ${table.verificationEvidence} IS NULL
            AND ${table.verifiedAt} IS NULL
            AND ${table.removeIntentAt} IS NULL
          )
          OR
          (
            ${table.status} = 'active'
            AND ${table.currentRuntimeIp} IS NOT NULL
            AND ${table.pendingRuntimeIp} IS NULL
            AND ${table.verificationIntentAt} IS NOT NULL
            AND ${table.verificationEvidence} IS NOT NULL
            AND ${table.verifiedAt} IS NOT NULL
            AND ${table.removeIntentAt} IS NULL
          )
          OR
          (
            ${table.status} = 'degraded'
            AND ${table.currentRuntimeIp} IS NOT NULL
            AND ${table.pendingRuntimeIp} IS NULL
            AND ${table.removeIntentAt} IS NULL
          )
          OR
          (
            ${table.status} = 'removing'
            AND ${table.currentRuntimeIp} IS NOT NULL
            AND ${table.pendingRuntimeIp} IS NULL
            AND ${table.removeIntentAt} IS NOT NULL
          )
          OR
          ${table.status} = 'cleanup_required'
        )`,
      ),
      check(
        'capsule_branch_previews_failure_check',
        sql`(
          (
            ${table.status} IN ('degraded', 'cleanup_required')
            AND ${table.failureCode} IS NOT NULL
            AND ${table.failureMessage} IS NOT NULL
            AND ${table.failureDetails} IS NOT NULL
            AND ${table.failureAt} IS NOT NULL
          )
          OR
          (
            ${table.status} NOT IN ('degraded', 'cleanup_required')
            AND ${table.failureCode} IS NULL
            AND ${table.failureMessage} IS NULL
            AND ${table.failureDetails} IS NULL
            AND ${table.failureAt} IS NULL
          )
        )`,
      ),
      check(
        'capsule_branch_previews_timestamp_order_check',
        sql`(
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
          AND
          (
            ${table.removeIntentAt} IS NULL
            OR (
              ${table.appliedAt} IS NOT NULL
              AND ${table.removeIntentAt} >= ${table.appliedAt}
            )
          )
        )`,
      ),
    ],
  )
}
