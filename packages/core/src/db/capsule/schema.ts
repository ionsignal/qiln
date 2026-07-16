import { type ExtractTablesFromSchema, type ExtractTablesWithRelations, type RelationsBuilderColumnBase } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { capsuleBranchesTable, createCapsuleBranchesTable } from './branch'
import {
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleBranchResourcesTable,
  createCapsuleBranchResourcesTable,
} from './branchResource'
import { capsuleLifecycleStatusEnum, capsulesTable, createCapsulesTable } from './capsule'
import { capsuleOperationStatusEnum, capsuleOperationsTable, capsuleOperationTypeEnum, createCapsuleOperationsTable } from './operation'
import { capsuleOperationStepStatusEnum, capsuleOperationStepsTable, createCapsuleOperationStepsTable } from './operationStep'
import { capsuleSnapshotsTable, createCapsuleSnapshotsTable } from './snapshot'
import type { RelationFragmentManyFn, RelationFragmentOneFn } from '../relations'

export {
  capsuleLifecycleStatusEnum,
  capsuleOperationStatusEnum,
  capsuleOperationStepStatusEnum,
  capsuleOperationTypeEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
}

export function createCapsuleSchema<TUserIdColumn extends PgColumn>(userIdColumn: TUserIdColumn) {
  const capsules = createCapsulesTable(userIdColumn)
  const capsuleBranches = createCapsuleBranchesTable(userIdColumn, capsules.id)
  const capsuleSnapshots = createCapsuleSnapshotsTable(capsules.id, capsuleBranches.id)
  const capsuleOperations = createCapsuleOperationsTable(userIdColumn, capsules.id, capsuleBranches.id)
  const capsuleBranchResources = createCapsuleBranchResourcesTable(userIdColumn, capsuleBranches.id, capsuleOperations.id)
  const capsuleOperationSteps = createCapsuleOperationStepsTable(userIdColumn, capsules.id, capsuleOperations.id, capsuleBranches.id)
  return {
    capsules,
    capsuleBranches,
    capsuleOperations,
    capsuleOperationSteps,
    capsuleBranchResources,
    capsuleSnapshots,
  }
}

export const capsuleRuntimeSchema = {
  capsules: capsulesTable,
  capsuleBranches: capsuleBranchesTable,
  capsuleOperations: capsuleOperationsTable,
  capsuleOperationSteps: capsuleOperationStepsTable,
  capsuleBranchResources: capsuleBranchResourcesTable,
  capsuleSnapshots: capsuleSnapshotsTable,
} as const

export interface CapsuleRelationHelpers {
  one: {
    users: RelationFragmentOneFn<'users'>
    capsules: RelationFragmentOneFn<'capsules'>
    capsuleBranches: RelationFragmentOneFn<'capsuleBranches'>
    capsuleOperations: RelationFragmentOneFn<'capsuleOperations'>
  }
  many: {
    capsules: RelationFragmentManyFn<'capsules'>
    capsuleBranches: RelationFragmentManyFn<'capsuleBranches'>
    capsuleOperations: RelationFragmentManyFn<'capsuleOperations'>
    capsuleOperationSteps: RelationFragmentManyFn<'capsuleOperationSteps'>
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
  capsuleOperations: {
    id: RelationsBuilderColumnBase<'capsuleOperations'>
    ownerId: RelationsBuilderColumnBase<'capsuleOperations'>
    capsuleId: RelationsBuilderColumnBase<'capsuleOperations'>
    branchId: RelationsBuilderColumnBase<'capsuleOperations'>
  }
  capsuleOperationSteps: {
    ownerId: RelationsBuilderColumnBase<'capsuleOperationSteps'>
    capsuleId: RelationsBuilderColumnBase<'capsuleOperationSteps'>
    operationId: RelationsBuilderColumnBase<'capsuleOperationSteps'>
    branchId: RelationsBuilderColumnBase<'capsuleOperationSteps'>
  }
  capsuleBranchResources: {
    ownerId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    branchId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    createdByOperationId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    lastOperationId: RelationsBuilderColumnBase<'capsuleBranchResources'>
  }
  capsuleSnapshots: {
    capsuleId: RelationsBuilderColumnBase<'capsuleSnapshots'>
    sourceBranchId: RelationsBuilderColumnBase<'capsuleSnapshots'>
  }
}

/**
 * Defines the full capsule relation fragment owned by @qiln/core.
 *
 * Host-owned reverse relations from users remain composed by the host because
 * the host owns the physical users table.
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
      operations: helpers.many.capsuleOperations({
        from: helpers.capsules.id,
        to: helpers.capsuleOperations.capsuleId,
      }),
      operationSteps: helpers.many.capsuleOperationSteps({
        from: helpers.capsules.id,
        to: helpers.capsuleOperationSteps.capsuleId,
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
      operations: helpers.many.capsuleOperations({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleOperations.branchId,
      }),
      operationSteps: helpers.many.capsuleOperationSteps({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleOperationSteps.branchId,
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
    capsuleOperations: {
      owner: helpers.one.users({
        from: helpers.capsuleOperations.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      capsule: helpers.one.capsules({
        from: helpers.capsuleOperations.capsuleId,
        to: helpers.capsules.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.capsuleOperations.branchId,
        to: helpers.capsuleBranches.id,
        optional: true,
      }),
      steps: helpers.many.capsuleOperationSteps({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleOperationSteps.operationId,
      }),
      resourcesCreated: helpers.many.capsuleBranchResources({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleBranchResources.createdByOperationId,
      }),
      resourcesLastTouched: helpers.many.capsuleBranchResources({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleBranchResources.lastOperationId,
      }),
    },
    capsuleOperationSteps: {
      owner: helpers.one.users({
        from: helpers.capsuleOperationSteps.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      capsule: helpers.one.capsules({
        from: helpers.capsuleOperationSteps.capsuleId,
        to: helpers.capsules.id,
        optional: false,
      }),
      operation: helpers.one.capsuleOperations({
        from: helpers.capsuleOperationSteps.operationId,
        to: helpers.capsuleOperations.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.capsuleOperationSteps.branchId,
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
      createdByOperation: helpers.one.capsuleOperations({
        from: helpers.capsuleBranchResources.createdByOperationId,
        to: helpers.capsuleOperations.id,
        optional: true,
      }),
      lastOperation: helpers.one.capsuleOperations({
        from: helpers.capsuleBranchResources.lastOperationId,
        to: helpers.capsuleOperations.id,
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
