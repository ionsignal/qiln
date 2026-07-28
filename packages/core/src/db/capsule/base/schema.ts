import type { PgColumn } from 'drizzle-orm/pg-core'
import { createCapsuleBranchesTable } from '../branch/record'
import { createCapsuleBranchResourcesTable } from '../branch/resource'
import {
  createCapsuleSnapshotCaptureOperationsTable,
  createCapsuleSnapshotCaptureResourcesTable,
} from '../operation/capture'
import { createCapsuleCreateOperationsTable } from '../operation/create'
import { createCapsuleForkOperationsTable } from '../operation/fork'
import { createCapsuleOperationsTable } from '../operation/record'
import { createCapsuleOperationStepsTable } from '../operation/step'
import { createCapsulesTable } from '../record'
import { createCapsuleSnapshotDependencyReferencesTable } from '../snapshot/dependency'
import { createCapsuleSnapshotGitRemotesTable, createCapsuleSnapshotGitRepositoriesTable } from '../snapshot/git'
import {
  createCapsuleArtifactEntriesTable,
  createCapsuleArtifactManifestRootsTable,
  createCapsuleArtifactManifestsTable,
} from '../snapshot/manifest'
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
  const capsuleArtifactManifests = createCapsuleArtifactManifestsTable(capsuleSnapshots.id)
  const capsuleArtifactManifestRoots = createCapsuleArtifactManifestRootsTable(capsuleArtifactManifests.id)
  const capsuleArtifactEntries = createCapsuleArtifactEntriesTable(capsuleArtifactManifestRoots.id)
  const capsuleSnapshotGitRepositories = createCapsuleSnapshotGitRepositoriesTable(
    capsuleSnapshots.id,
    capsuleArtifactManifestRoots.id,
  )
  const capsuleSnapshotGitRemotes = createCapsuleSnapshotGitRemotesTable(capsuleSnapshotGitRepositories.id)
  const capsuleSnapshotDependencyReferences = createCapsuleSnapshotDependencyReferencesTable(
    capsuleSnapshots.id,
    capsuleArtifactManifestRoots.id,
    capsuleBranchResources.id,
  )
  const capsuleSnapshotCaptureOperations = createCapsuleSnapshotCaptureOperationsTable(
    capsuleOperations.id,
    capsuleBranches.id,
    capsuleSnapshots.id,
  )
  const capsuleSnapshotCaptureResources = createCapsuleSnapshotCaptureResourcesTable(
    capsuleSnapshotCaptureOperations.operationId,
    capsuleBranchResources.id,
  )
  const capsuleSnapshotResourceReferences = createCapsuleSnapshotResourceReferencesTable(
    capsuleSnapshots.id,
    capsuleArtifactManifestRoots.id,
    capsuleBranchResources.id,
    capsuleSnapshotCaptureResources.id,
  )
  return {
    capsules,
    capsuleBranches,
    capsuleOperations,
    capsuleCreateOperations,
    capsuleForkOperations,
    capsuleOperationSteps,
    capsuleBranchResources,
    capsuleSnapshots,
    capsuleArtifactManifests,
    capsuleArtifactManifestRoots,
    capsuleArtifactEntries,
    capsuleSnapshotGitRepositories,
    capsuleSnapshotGitRemotes,
    capsuleSnapshotDependencyReferences,
    capsuleSnapshotResourceReferences,
    capsuleSnapshotCaptureOperations,
    capsuleSnapshotCaptureResources,
  }
}

export type Tables = ReturnType<typeof createSchema>
