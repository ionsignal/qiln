import type { PgColumn } from 'drizzle-orm/pg-core'
import { createCapsuleBranchesTable } from '../branch/record'
import { createCapsuleBranchRuntimeOperationsTable } from '../operation/runtime'
import { createCapsuleBranchResourcesTable } from '../branch/resource'
import {
  createCapsuleSnapshotCreateOperationsTable,
  createCapsuleSnapshotCreateResourcesTable,
} from '../operation/snapshot'
import { createCapsuleCreateOperationsTable } from '../operation/create'
import { createCapsuleForkOperationsTable } from '../operation/fork'
import { createCapsuleOperationsTable } from '../operation/record'
import { createCapsuleOperationStepsTable } from '../operation/step'
import { createCapsulesTable } from '../record'
import { createCapsuleSnapshotsTable } from '../snapshot/record'
import { createCapsuleSnapshotResourceReferencesTable } from '../snapshot/resource'

/**
 * Creates the capsule aggregate, branch, operation, resource, and snapshot
 * tables owned by the base capsule persistence fragment.
 *
 * Routing is composed separately so it can consume the exact capsule,
 * operation, and snapshot handles returned by this factory.
 */
export function createSchema<TUserIdColumn extends PgColumn>(userIdColumn: TUserIdColumn) {
  const capsules = createCapsulesTable(userIdColumn)
  const capsuleBranches = createCapsuleBranchesTable(userIdColumn, capsules.id)
  const capsuleOperations = createCapsuleOperationsTable(userIdColumn, capsules.id)
  const capsuleBranchRuntimeOperations = createCapsuleBranchRuntimeOperationsTable(
    capsuleOperations.id,
    capsuleBranches.id,
  )
  const capsuleCreateOperations = createCapsuleCreateOperationsTable(capsuleOperations.id, capsuleBranches.id)
  const capsuleBranchResources = createCapsuleBranchResourcesTable(
    userIdColumn,
    capsuleBranches.id,
    capsuleOperations.id,
  )
  const capsuleOperationSteps = createCapsuleOperationStepsTable(
    userIdColumn,
    capsules.id,
    capsuleOperations.id,
    capsuleBranches.id,
  )
  const capsuleSnapshots = createCapsuleSnapshotsTable(capsules.id, capsuleBranches.id)
  const capsuleForkOperations = createCapsuleForkOperationsTable(
    capsuleOperations.id,
    capsuleSnapshots.id,
    capsuleBranches.id,
  )
  const capsuleSnapshotCreateOperations = createCapsuleSnapshotCreateOperationsTable(
    capsuleOperations.id,
    capsuleBranches.id,
    capsuleSnapshots.id,
  )
  const capsuleSnapshotCreateResources = createCapsuleSnapshotCreateResourcesTable(
    capsuleSnapshotCreateOperations.operationId,
    capsuleBranchResources.id,
  )
  const capsuleSnapshotResourceReferences = createCapsuleSnapshotResourceReferencesTable(
    capsuleSnapshots.id,
    capsuleBranchResources.id,
    capsuleSnapshotCreateResources.id,
  )
  return {
    capsules,
    capsuleBranches,
    capsuleOperations,
    capsuleCreateOperations,
    capsuleForkOperations,
    capsuleBranchRuntimeOperations,
    capsuleOperationSteps,
    capsuleBranchResources,
    capsuleSnapshots,
    capsuleSnapshotCreateOperations,
    capsuleSnapshotCreateResources,
    capsuleSnapshotResourceReferences,
  }
}

export type Tables = ReturnType<typeof createSchema>
