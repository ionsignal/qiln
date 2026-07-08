import { type ExtractTablesFromSchema, type ExtractTablesWithRelations, type RelationsBuilderColumnBase } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { capsuleBranchesTable, createCapsuleBranchesTable } from './branch'
import {
  capsuleBranchOperationStatusEnum,
  capsuleBranchOperationTypeEnum,
  capsuleBranchOperationsTable,
  createCapsuleBranchOperationsTable,
} from './branchOperation'
import {
  capsuleBranchOperationStepStatusEnum,
  capsuleBranchOperationStepsTable,
  createCapsuleBranchOperationStepsTable,
} from './branchOperationStep'
import {
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleBranchResourcesTable,
  createCapsuleBranchResourcesTable,
} from './branchResource'
import type { RelationFragmentManyFn, RelationFragmentOneFn } from '../relations'

export {
  capsuleBranchOperationStatusEnum,
  capsuleBranchOperationStepStatusEnum,
  capsuleBranchOperationTypeEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
}

export function createCapsuleSchema<TUserIdColumn extends PgColumn>(userIdColumn: TUserIdColumn) {
  const capsuleBranches = createCapsuleBranchesTable(userIdColumn)
  const capsuleBranchOperations = createCapsuleBranchOperationsTable(userIdColumn, capsuleBranches.id)
  const capsuleBranchOperationSteps = createCapsuleBranchOperationStepsTable(userIdColumn, capsuleBranchOperations.id, capsuleBranches.id)
  const capsuleBranchResources = createCapsuleBranchResourcesTable(userIdColumn, capsuleBranches.id, capsuleBranchOperations.id)
  return {
    capsuleBranches,
    capsuleBranchOperations,
    capsuleBranchOperationSteps,
    capsuleBranchResources,
  }
}

export const capsuleRuntimeSchema = {
  capsuleBranches: capsuleBranchesTable,
  capsuleBranchOperations: capsuleBranchOperationsTable,
  capsuleBranchOperationSteps: capsuleBranchOperationStepsTable,
  capsuleBranchResources: capsuleBranchResourcesTable,
} as const

export interface CapsuleRelationHelpers {
  one: {
    users: RelationFragmentOneFn<'users'>
    capsuleBranches: RelationFragmentOneFn<'capsuleBranches'>
    capsuleBranchOperations: RelationFragmentOneFn<'capsuleBranchOperations'>
  }
  many: {
    capsuleBranchOperations: RelationFragmentManyFn<'capsuleBranchOperations'>
    capsuleBranchOperationSteps: RelationFragmentManyFn<'capsuleBranchOperationSteps'>
    capsuleBranchResources: RelationFragmentManyFn<'capsuleBranchResources'>
  }
  users: {
    id: RelationsBuilderColumnBase<'users'>
  }
  capsuleBranches: {
    id: RelationsBuilderColumnBase<'capsuleBranches'>
    ownerId: RelationsBuilderColumnBase<'capsuleBranches'>
  }
  capsuleBranchOperations: {
    id: RelationsBuilderColumnBase<'capsuleBranchOperations'>
    ownerId: RelationsBuilderColumnBase<'capsuleBranchOperations'>
    branchId: RelationsBuilderColumnBase<'capsuleBranchOperations'>
  }
  capsuleBranchOperationSteps: {
    ownerId: RelationsBuilderColumnBase<'capsuleBranchOperationSteps'>
    operationId: RelationsBuilderColumnBase<'capsuleBranchOperationSteps'>
    branchId: RelationsBuilderColumnBase<'capsuleBranchOperationSteps'>
  }
  capsuleBranchResources: {
    ownerId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    branchId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    createdByOperationId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    lastOperationId: RelationsBuilderColumnBase<'capsuleBranchResources'>
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
      operations: helpers.many.capsuleBranchOperations({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleBranchOperations.branchId,
      }),
      operationSteps: helpers.many.capsuleBranchOperationSteps({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleBranchOperationSteps.branchId,
      }),
      resources: helpers.many.capsuleBranchResources({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleBranchResources.branchId,
      }),
    },
    capsuleBranchOperations: {
      owner: helpers.one.users({
        from: helpers.capsuleBranchOperations.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.capsuleBranchOperations.branchId,
        to: helpers.capsuleBranches.id,
        optional: true,
      }),
      steps: helpers.many.capsuleBranchOperationSteps({
        from: helpers.capsuleBranchOperations.id,
        to: helpers.capsuleBranchOperationSteps.operationId,
      }),
      resourcesCreated: helpers.many.capsuleBranchResources({
        from: helpers.capsuleBranchOperations.id,
        to: helpers.capsuleBranchResources.createdByOperationId,
      }),
      resourcesLastTouched: helpers.many.capsuleBranchResources({
        from: helpers.capsuleBranchOperations.id,
        to: helpers.capsuleBranchResources.lastOperationId,
      }),
    },
    capsuleBranchOperationSteps: {
      owner: helpers.one.users({
        from: helpers.capsuleBranchOperationSteps.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      operation: helpers.one.capsuleBranchOperations({
        from: helpers.capsuleBranchOperationSteps.operationId,
        to: helpers.capsuleBranchOperations.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.capsuleBranchOperationSteps.branchId,
        to: helpers.capsuleBranches.id,
        optional: true,
      }),
    },
    capsuleBranchResources: {
      owner: helpers.one.users({
        from: helpers.capsuleBranchResources.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.capsuleBranchResources.branchId,
        to: helpers.capsuleBranches.id,
        optional: true,
      }),
      createdByOperation: helpers.one.capsuleBranchOperations({
        from: helpers.capsuleBranchResources.createdByOperationId,
        to: helpers.capsuleBranchOperations.id,
        optional: true,
      }),
      lastOperation: helpers.one.capsuleBranchOperations({
        from: helpers.capsuleBranchResources.lastOperationId,
        to: helpers.capsuleBranchOperations.id,
        optional: true,
      }),
    },
  }
}

type CapsuleRuntimeRelations = ExtractTablesWithRelations<{}, ExtractTablesFromSchema<typeof capsuleRuntimeSchema>>

export type CapsuleHostDbContract = PostgresJsDatabase<CapsuleRuntimeRelations>
