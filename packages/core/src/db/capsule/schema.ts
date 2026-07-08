import { type ExtractTablesFromSchema, type ExtractTablesWithRelations, type RelationsBuilderColumnBase } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { capsuleBranchesTable, createCapsuleBranchesTable, type CapsuleBranchHostDbContract } from './branch'
import {
  createCapsuleOperationResourcesTable,
  createCapsuleOperationsTable,
  capsuleOperationCleanupPolicyEnum,
  capsuleOperationResourceStatusEnum,
  capsuleOperationResourceTypeEnum,
  capsuleOperationStatusEnum,
  capsuleOperationTypeEnum,
} from './operation'
import type { RelationFragmentManyFn, RelationFragmentOneFn } from '../relations'

export {
  capsuleOperationCleanupPolicyEnum,
  capsuleOperationResourceStatusEnum,
  capsuleOperationResourceTypeEnum,
  capsuleOperationStatusEnum,
  capsuleOperationTypeEnum,
}

export function createCapsuleSchema<TUserIdColumn extends PgColumn>(userIdColumn: TUserIdColumn) {
  const capsuleBranches = createCapsuleBranchesTable(userIdColumn)
  const capsuleOperations = createCapsuleOperationsTable(userIdColumn, capsuleBranches.id)
  const capsuleOperationResources = createCapsuleOperationResourcesTable(userIdColumn, capsuleOperations.id, capsuleBranches.id)
  return {
    capsuleBranches,
    capsuleOperations,
    capsuleOperationResources,
  }
}

export const capsuleOperationsTable = createCapsuleOperationsTable(undefined, capsuleBranchesTable.id)
export const capsuleOperationResourcesTable = createCapsuleOperationResourcesTable(
  undefined,
  capsuleOperationsTable.id,
  capsuleBranchesTable.id,
)

export const capsuleRuntimeSchema = {
  capsuleBranches: capsuleBranchesTable,
  capsuleOperations: capsuleOperationsTable,
  capsuleOperationResources: capsuleOperationResourcesTable,
} as const

export const capsuleLibrarySchema = capsuleRuntimeSchema

export interface CapsuleRelationHelpers {
  one: {
    users: RelationFragmentOneFn<'users'>
    capsuleBranches: RelationFragmentOneFn<'capsuleBranches'>
    capsuleOperations: RelationFragmentOneFn<'capsuleOperations'>
  }
  many: {
    capsuleOperations: RelationFragmentManyFn<'capsuleOperations'>
    capsuleOperationResources: RelationFragmentManyFn<'capsuleOperationResources'>
  }
  users: {
    id: RelationsBuilderColumnBase<'users'>
  }
  capsuleBranches: {
    id: RelationsBuilderColumnBase<'capsuleBranches'>
    ownerId: RelationsBuilderColumnBase<'capsuleBranches'>
  }
  capsuleOperations: {
    id: RelationsBuilderColumnBase<'capsuleOperations'>
    ownerId: RelationsBuilderColumnBase<'capsuleOperations'>
    branchId: RelationsBuilderColumnBase<'capsuleOperations'>
  }
  capsuleOperationResources: {
    ownerId: RelationsBuilderColumnBase<'capsuleOperationResources'>
    operationId: RelationsBuilderColumnBase<'capsuleOperationResources'>
    branchId: RelationsBuilderColumnBase<'capsuleOperationResources'>
  }
}

/**
 * Defines the full capsule relation fragment owned by @qiln/core.
 *
 * Host-owned reverse relations from `users` are still composed in the host app
 * because the host owns the physical users table.
 */
export function defineCapsuleRelations(helpers: CapsuleRelationHelpers) {
  return {
    capsuleBranches: {
      owner: helpers.one.users({
        from: helpers.capsuleBranches.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      operations: helpers.many.capsuleOperations({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleOperations.branchId,
      }),
      resources: helpers.many.capsuleOperationResources({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleOperationResources.branchId,
      }),
    },
    capsuleOperations: {
      owner: helpers.one.users({
        from: helpers.capsuleOperations.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.capsuleOperations.branchId,
        to: helpers.capsuleBranches.id,
        optional: true,
      }),
      resources: helpers.many.capsuleOperationResources({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleOperationResources.operationId,
      }),
    },
    capsuleOperationResources: {
      owner: helpers.one.users({
        from: helpers.capsuleOperationResources.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      operation: helpers.one.capsuleOperations({
        from: helpers.capsuleOperationResources.operationId,
        to: helpers.capsuleOperations.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.capsuleOperationResources.branchId,
        to: helpers.capsuleBranches.id,
        optional: true,
      }),
    },
  }
}

type CapsuleRuntimeRelations = ExtractTablesWithRelations<{}, ExtractTablesFromSchema<typeof capsuleRuntimeSchema>>

export type CapsuleHostDbContract = PostgresJsDatabase<CapsuleRuntimeRelations>

/**
 * Compatibility alias for call sites that have not yet been renamed. New code
 * should depend on `CapsuleHostDbContract`.
 */
export type CapsuleBranchDbContract = CapsuleBranchHostDbContract
