import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgColumn,
} from 'drizzle-orm/pg-core'
import {
  CapsuleRouteAliasStatusValues,
  CapsuleRouteExposureValues,
  CapsuleRouteMethodValues,
  type CapsuleRouteMatcherDigest,
} from '../../../schemas'

export const capsuleRouteExposureEnum = pgEnum('capsule_route_exposure', CapsuleRouteExposureValues)
export const capsuleRouteMethodEnum = pgEnum('capsule_route_method', CapsuleRouteMethodValues)
export const capsuleRouteAliasStatusEnum = pgEnum('capsule_route_alias_status', CapsuleRouteAliasStatusValues)

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

function createNullableOperationIdColumn(columnName: string, operationIdColumn?: PgColumn) {
  const column = uuid(columnName)
  return operationIdColumn
    ? column.references(() => operationIdColumn, {
        onDelete: 'restrict',
      })
    : column
}

/**
 * Creates stable route aliases.
 *
 * An alias owns one canonical exact matcher and an exposure class. Its current
 * committed target is stored separately in `capsule_route_heads`, allowing
 * proposed revisions and provider mutations to remain invisible to committed
 * reads.
 *
 * `mutationOperationId` is the route-level mutation fence. The capsule-wide
 * nonterminal-operation fence remains authoritative and must be acquired in the
 * same operation-specific acceptance transaction.
 */
export function createCapsuleRouteAliasesTable(
  ownerIdColumn?: PgColumn,
  capsuleIdColumn?: PgColumn,
  operationIdColumn?: PgColumn,
) {
  const ownerId = createOwnerIdColumn(ownerIdColumn)
  const capsuleId = createCapsuleIdColumn(capsuleIdColumn)
  const mutationOperationId = createNullableOperationIdColumn('mutation_operation_id', operationIdColumn)
  const lastOperationId = createNullableOperationIdColumn('last_operation_id', operationIdColumn)
  return pgTable(
    'capsule_route_aliases',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      ownerId,
      capsuleId,
      name: text('name').notNull(),
      exposure: capsuleRouteExposureEnum('exposure').notNull(),
      host: text('host').notNull(),
      path: text('path').notNull(),
      methods: capsuleRouteMethodEnum('methods').array().notNull(),
      matcherDigest: text('matcher_digest').$type<CapsuleRouteMatcherDigest>().notNull(),
      status: capsuleRouteAliasStatusEnum('status').notNull().default('inactive'),
      mutationOperationId,
      lastOperationId,
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
      index('capsule_route_aliases_owner_idx').on(table.ownerId),
      index('capsule_route_aliases_capsule_idx').on(table.capsuleId),
      index('capsule_route_aliases_status_idx').on(table.status),
      index('capsule_route_aliases_mutation_operation_idx').on(table.mutationOperationId),
      index('capsule_route_aliases_last_operation_idx').on(table.lastOperationId),
      uniqueIndex('capsule_route_aliases_owner_capsule_name_unique_idx').on(table.ownerId, table.capsuleId, table.name),
      uniqueIndex('capsule_route_aliases_match_unique_idx').on(table.host, table.path),
      check(
        'capsule_route_aliases_host_check',
        sql`(
          length(${table.host}) BETWEEN 3 AND 253
          AND ${table.host} = lower(${table.host})
          AND ${table.host} !~ '[*><@/?#]'
          AND ${table.host} !~ '\\.$'
        )`,
      ),
      check(
        'capsule_route_aliases_path_check',
        sql`(
          ${table.path} LIKE '/%'
          AND ${table.path} !~ '[?#]'
          AND (${table.path} = '/' OR ${table.path} !~ '/$')
        )`,
      ),
      check('capsule_route_aliases_methods_check', sql`cardinality(${table.methods}) > 0`),
      check('capsule_route_aliases_matcher_digest_check', sql`${table.matcherDigest} ~ '^sha256:[a-f0-9]{64}$'`),
      check(
        'capsule_route_aliases_mutation_fence_check',
        sql`(
          (
            ${table.status} = 'mutating'
            AND ${table.mutationOperationId} IS NOT NULL
          )
          OR
          (
            ${table.status} <> 'mutating'
            AND ${table.mutationOperationId} IS NULL
          )
        )`,
      ),
    ],
  )
}

/**
 * Creates the committed head pointer for one route alias.
 *
 * A missing row means the alias has no committed target. The composite foreign
 * key proves that the referenced revision belongs to this alias. Repository
 * transactions must additionally prove that the revision is committed and
 * agrees with the alias matcher before inserting or updating the head.
 */
export function createCapsuleRouteHeadsTable(
  routeAliasIdColumn?: PgColumn,
  routeRevisionIdColumn?: PgColumn,
  routeRevisionAliasIdColumn?: PgColumn,
) {
  const aliasId = routeAliasIdColumn
    ? uuid('alias_id')
        .primaryKey()
        .references(() => routeAliasIdColumn, { onDelete: 'cascade' })
    : uuid('alias_id').primaryKey()
  const revisionId = routeRevisionIdColumn
    ? uuid('revision_id')
        .notNull()
        .references(() => routeRevisionIdColumn, { onDelete: 'restrict' })
    : uuid('revision_id').notNull()
  return pgTable(
    'capsule_route_heads',
    {
      aliasId,
      revisionId,
      updatedAt: timestamp('updated_at', {
        withTimezone: true,
        mode: 'date',
        precision: 3,
      })
        .notNull()
        .defaultNow(),
    },
    table => [
      uniqueIndex('capsule_route_heads_revision_unique_idx').on(table.revisionId),
      index('capsule_route_heads_updated_idx').on(table.updatedAt),
      ...(routeRevisionAliasIdColumn && routeRevisionIdColumn
        ? [
            foreignKey({
              columns: [table.aliasId, table.revisionId],
              foreignColumns: [routeRevisionAliasIdColumn, routeRevisionIdColumn],
              name: 'capsule_route_heads_alias_revision_fk',
            }).onDelete('restrict'),
          ]
        : []),
    ],
  )
}
