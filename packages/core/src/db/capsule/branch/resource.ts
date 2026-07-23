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
  CapsuleBranchResourceCleanupPolicyValues,
  CapsuleBranchResourceStatusValues,
  CapsuleBranchResourceTypeValues,
  type CapsuleBlueprintIdentifier,
} from '../../../schemas'
import { capsuleOperationsTable } from '../operation/record'
import { capsuleBranchesTable } from './record'

export const capsuleBranchResourceTypeEnum = pgEnum('capsule_branch_resource_type', CapsuleBranchResourceTypeValues)
export const capsuleBranchResourceStatusEnum = pgEnum(
  'capsule_branch_resource_status',
  CapsuleBranchResourceStatusValues,
)
export const capsuleBranchResourceCleanupPolicyEnum = pgEnum(
  'capsule_branch_resource_cleanup_policy',
  CapsuleBranchResourceCleanupPolicyValues,
)

function createOwnerIdColumn(ownerIdColumn?: PgColumn) {
  return ownerIdColumn
    ? uuid('owner_id')
        .notNull()
        .references(() => ownerIdColumn, { onDelete: 'cascade' })
    : uuid('owner_id').notNull()
}

function createNullableBranchIdColumn(branchIdColumn?: PgColumn) {
  return branchIdColumn
    ? uuid('branch_id').references(() => branchIdColumn, {
        onDelete: 'set null',
      })
    : uuid('branch_id')
}

function createNullableOperationIdColumn(columnName: string, operationIdColumn?: PgColumn) {
  const column = uuid(columnName)

  return operationIdColumn
    ? column.references(() => operationIdColumn, {
        onDelete: 'set null',
      })
    : column
}

/**
 * Durable branch resource inventory.
 *
 * Operation provenance records which operation created and last touched a
 * resource. Destroy can delete only resources whose durable inventory, cleanup
 * policy, and provider state satisfy fail-closed ownership checks.
 *
 * Managed volumes and bind mounts retain their originating blueprint volume
 * identity. Snapshot Capture must resolve capture-policy roots and external
 * boundaries through this explicit identity rather than provider names, mount
 * paths, or live provider discovery.
 */
export function createCapsuleBranchResourcesTable(
  ownerIdColumn?: PgColumn,
  branchIdColumn?: PgColumn,
  operationIdColumn?: PgColumn,
) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const branchId = createNullableBranchIdColumn(branchIdColumn)
  const lastOperationId = createNullableOperationIdColumn('last_operation_id', operationIdColumn)
  const createdByOperationId = createNullableOperationIdColumn('created_by_operation_id', operationIdColumn)

  return pgTable(
    'capsule_branch_resources',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      branchId,
      branchName: text('branch_name').notNull(),
      createdByOperationId,
      lastOperationId,
      resourceType: capsuleBranchResourceTypeEnum('resource_type').notNull(),
      provider: text('provider').notNull().default('incus'),
      resourceKey: text('resource_key').notNull(),
      blueprintVolumeName: text('blueprint_volume_name').$type<CapsuleBlueprintIdentifier>(),
      status: capsuleBranchResourceStatusEnum('status').notNull().default('planned'),
      cleanupPolicy: capsuleBranchResourceCleanupPolicyEnum('cleanup_policy').notNull(),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
      failureCode: text('failure_code'),
      failureMessage: text('failure_message'),
      failureDetails: jsonb('failure_details').$type<Record<string, unknown>>(),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'date',
      })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp('updated_at', {
        withTimezone: true,
        mode: 'date',
      })
        .notNull()
        .defaultNow(),
    },
    table => [
      index('capsule_branch_resources_owner_idx').on(table.ownerId),
      index('capsule_branch_resources_branch_idx').on(table.branchId),
      index('capsule_branch_resources_created_by_operation_idx').on(table.createdByOperationId),
      index('capsule_branch_resources_last_operation_idx').on(table.lastOperationId),
      index('capsule_branch_resources_resource_key_idx').on(table.resourceKey),
      index('capsule_branch_resources_blueprint_volume_idx').on(table.blueprintVolumeName),
      uniqueIndex('capsule_branch_resources_operation_key_unique_idx').on(
        table.createdByOperationId,
        table.resourceKey,
      ),
      uniqueIndex('capsule_branch_resources_branch_key_unique_idx').on(table.branchId, table.resourceKey),
      uniqueIndex('capsule_branch_resources_branch_blueprint_volume_unique_idx')
        .on(table.branchId, table.blueprintVolumeName)
        .where(sql`${table.blueprintVolumeName} IS NOT NULL`),
      check(
        'capsule_branch_resources_blueprint_volume_check',
        sql`(
          (
            ${table.resourceType} IN ('zfs_volume', 'bind_mount')
            AND ${table.blueprintVolumeName} IS NOT NULL
          )
          OR
          (
            ${table.resourceType} NOT IN ('zfs_volume', 'bind_mount')
            AND ${table.blueprintVolumeName} IS NULL
          )
        )`,
      ),
    ],
  )
}

export const capsuleBranchResourcesTable = createCapsuleBranchResourcesTable(
  undefined,
  capsuleBranchesTable.id,
  capsuleOperationsTable.id,
)
