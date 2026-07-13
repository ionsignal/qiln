import { type ExtractTablesFromSchema, type ExtractTablesWithRelations, type RelationsBuilderColumnBase } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { capsuleBranchesTable, createCapsuleBranchesTable } from './branch'
import {
  capsuleLifecycleOperationStatusEnum,
  capsuleLifecycleOperationTypeEnum,
  capsuleLifecycleOperationsTable,
  createCapsuleLifecycleOperationsTable,
} from './lifecycleOperation'
import {
  capsuleLifecycleOperationStepStatusEnum,
  capsuleLifecycleOperationStepsTable,
  createCapsuleLifecycleOperationStepsTable,
} from './lifecycleOperationStep'
import {
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleBranchResourcesTable,
  createCapsuleBranchResourcesTable,
} from './branchResource'
import { capsuleLifecycleStatusEnum, capsulesTable, createCapsulesTable } from './capsule'
import { capsuleSnapshotsTable, createCapsuleSnapshotsTable } from './snapshot'
import type { RelationFragmentManyFn, RelationFragmentOneFn } from '../relations'

export {
  capsuleLifecycleStatusEnum,
  capsuleLifecycleOperationStatusEnum,
  capsuleLifecycleOperationStepStatusEnum,
  capsuleLifecycleOperationTypeEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
}

export function createCapsuleSchema<TUserIdColumn extends PgColumn>(userIdColumn: TUserIdColumn) {
  const capsules = createCapsulesTable(userIdColumn)
  const capsuleBranches = createCapsuleBranchesTable(userIdColumn, capsules.id)
  const capsuleSnapshots = createCapsuleSnapshotsTable(capsules.id, capsuleBranches.id)
  const capsuleLifecycleOperations = createCapsuleLifecycleOperationsTable(userIdColumn, capsules.id, capsuleBranches.id)
  const capsuleBranchResources = createCapsuleBranchResourcesTable(userIdColumn, capsuleBranches.id, capsuleLifecycleOperations.id)
  const capsuleLifecycleOperationSteps = createCapsuleLifecycleOperationStepsTable(
    userIdColumn,
    capsules.id,
    capsuleLifecycleOperations.id,
    capsuleBranches.id,
  )
  return {
    capsules,
    capsuleBranches,
    capsuleLifecycleOperations,
    capsuleLifecycleOperationSteps,
    capsuleBranchResources,
    capsuleSnapshots,
  }
}

export const capsuleRuntimeSchema = {
  capsules: capsulesTable,
  capsuleBranches: capsuleBranchesTable,
  capsuleLifecycleOperations: capsuleLifecycleOperationsTable,
  capsuleLifecycleOperationSteps: capsuleLifecycleOperationStepsTable,
  capsuleBranchResources: capsuleBranchResourcesTable,
  capsuleSnapshots: capsuleSnapshotsTable,
} as const

export interface CapsuleRelationHelpers {
  one: {
    users: RelationFragmentOneFn<'users'>
    capsules: RelationFragmentOneFn<'capsules'>
    capsuleBranches: RelationFragmentOneFn<'capsuleBranches'>
    capsuleLifecycleOperations: RelationFragmentOneFn<'capsuleLifecycleOperations'>
  }
  many: {
    capsules: RelationFragmentManyFn<'capsules'>
    capsuleBranches: RelationFragmentManyFn<'capsuleBranches'>
    capsuleLifecycleOperations: RelationFragmentManyFn<'capsuleLifecycleOperations'>
    capsuleLifecycleOperationSteps: RelationFragmentManyFn<'capsuleLifecycleOperationSteps'>
    capsuleBranchResources: RelationFragmentManyFn<'capsuleBranchResources'>
    capsuleSnapshots: RelationFragmentManyFn<'capsuleSnapshots'>
  }
  users: {
    id: RelationsBuilderColumnBase<'users'>
  }
  capsules: {
    id: RelationsBuilderColumnBase<'capsules'>
    ownerId: RelationsBuilderColumnBase<'capsules'>
  }
  capsuleBranches: {
    id: RelationsBuilderColumnBase<'capsuleBranches'>
    ownerId: RelationsBuilderColumnBase<'capsuleBranches'>
    capsuleId: RelationsBuilderColumnBase<'capsuleBranches'>
  }
  capsuleLifecycleOperations: {
    id: RelationsBuilderColumnBase<'capsuleLifecycleOperations'>
    ownerId: RelationsBuilderColumnBase<'capsuleLifecycleOperations'>
    capsuleId: RelationsBuilderColumnBase<'capsuleLifecycleOperations'>
    branchId: RelationsBuilderColumnBase<'capsuleLifecycleOperations'>
  }
  capsuleLifecycleOperationSteps: {
    ownerId: RelationsBuilderColumnBase<'capsuleLifecycleOperationSteps'>
    capsuleId: RelationsBuilderColumnBase<'capsuleLifecycleOperationSteps'>
    operationId: RelationsBuilderColumnBase<'capsuleLifecycleOperationSteps'>
    branchId: RelationsBuilderColumnBase<'capsuleLifecycleOperationSteps'>
  }
  capsuleBranchResources: {
    ownerId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    branchId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    createdByLifecycleOperationId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    lastLifecycleOperationId: RelationsBuilderColumnBase<'capsuleBranchResources'>
  }
  capsuleSnapshots: {
    capsuleId: RelationsBuilderColumnBase<'capsuleSnapshots'>
    sourceBranchId: RelationsBuilderColumnBase<'capsuleSnapshots'>
  }
}

/**
 * Defines the full capsule relation fragment owned by @qiln/core.
 *
 * Host-owned reverse relations from users remain composed by the host because the host owns the physical users table.
 */
export function defineCapsuleRelations(helpers: CapsuleRelationHelpers) {
  return {
    capsules: {
      owner: helpers.one.users({
        from: helpers.capsules.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      branches: helpers.many.capsuleBranches({
        from: helpers.capsules.id,
        to: helpers.capsuleBranches.capsuleId,
      }),
      lifecycleOperations: helpers.many.capsuleLifecycleOperations({
        from: helpers.capsules.id,
        to: helpers.capsuleLifecycleOperations.capsuleId,
      }),
      lifecycleOperationSteps: helpers.many.capsuleLifecycleOperationSteps({
        from: helpers.capsules.id,
        to: helpers.capsuleLifecycleOperationSteps.capsuleId,
      }),
      snapshots: helpers.many.capsuleSnapshots({
        from: helpers.capsules.id,
        to: helpers.capsuleSnapshots.capsuleId,
      }),
    },
    capsuleBranches: {
      owner: helpers.one.users({
        from: helpers.capsuleBranches.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      capsule: helpers.one.capsules({
        from: helpers.capsuleBranches.capsuleId,
        to: helpers.capsules.id,
        optional: false,
      }),
      lifecycleOperations: helpers.many.capsuleLifecycleOperations({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleLifecycleOperations.branchId,
      }),
      lifecycleOperationSteps: helpers.many.capsuleLifecycleOperationSteps({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleLifecycleOperationSteps.branchId,
      }),
      resources: helpers.many.capsuleBranchResources({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleBranchResources.branchId,
      }),
      snapshots: helpers.many.capsuleSnapshots({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleSnapshots.sourceBranchId,
      }),
    },
    capsuleLifecycleOperations: {
      owner: helpers.one.users({
        from: helpers.capsuleLifecycleOperations.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      capsule: helpers.one.capsules({
        from: helpers.capsuleLifecycleOperations.capsuleId,
        to: helpers.capsules.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.capsuleLifecycleOperations.branchId,
        to: helpers.capsuleBranches.id,
        optional: true,
      }),
      steps: helpers.many.capsuleLifecycleOperationSteps({
        from: helpers.capsuleLifecycleOperations.id,
        to: helpers.capsuleLifecycleOperationSteps.operationId,
      }),
      resourcesCreated: helpers.many.capsuleBranchResources({
        from: helpers.capsuleLifecycleOperations.id,
        to: helpers.capsuleBranchResources.createdByLifecycleOperationId,
      }),
      resourcesLastTouched: helpers.many.capsuleBranchResources({
        from: helpers.capsuleLifecycleOperations.id,
        to: helpers.capsuleBranchResources.lastLifecycleOperationId,
      }),
    },
    capsuleLifecycleOperationSteps: {
      owner: helpers.one.users({
        from: helpers.capsuleLifecycleOperationSteps.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      capsule: helpers.one.capsules({
        from: helpers.capsuleLifecycleOperationSteps.capsuleId,
        to: helpers.capsules.id,
        optional: false,
      }),
      operation: helpers.one.capsuleLifecycleOperations({
        from: helpers.capsuleLifecycleOperationSteps.operationId,
        to: helpers.capsuleLifecycleOperations.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.capsuleLifecycleOperationSteps.branchId,
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
      createdByLifecycleOperation: helpers.one.capsuleLifecycleOperations({
        from: helpers.capsuleBranchResources.createdByLifecycleOperationId,
        to: helpers.capsuleLifecycleOperations.id,
        optional: true,
      }),
      lastLifecycleOperation: helpers.one.capsuleLifecycleOperations({
        from: helpers.capsuleBranchResources.lastLifecycleOperationId,
        to: helpers.capsuleLifecycleOperations.id,
        optional: true,
      }),
    },
    capsuleSnapshots: {
      capsule: helpers.one.capsules({
        from: helpers.capsuleSnapshots.capsuleId,
        to: helpers.capsules.id,
        optional: false,
      }),
      sourceBranch: helpers.one.capsuleBranches({
        from: helpers.capsuleSnapshots.sourceBranchId,
        to: helpers.capsuleBranches.id,
        optional: false,
      }),
    },
  }
}

type CapsuleRuntimeRelations = ExtractTablesWithRelations<{}, ExtractTablesFromSchema<typeof capsuleRuntimeSchema>>

export type CapsuleHostDbContract = PostgresJsDatabase<CapsuleRuntimeRelations>
