import {
  type ExtractTablesFromSchema,
  type ExtractTablesWithRelations,
  type RelationsBuilderColumnBase,
} from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { capsuleBranchesTable, createCapsuleBranchesTable } from './branch/record'
import {
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleBranchResourcesTable,
  createCapsuleBranchResourcesTable,
} from './branch/resource'
import { capsuleCreateOperationsTable, createCapsuleCreateOperationsTable } from './operation/create'
import { capsuleSnapshotCaptureOperationsTable, createCapsuleSnapshotCaptureOperationsTable } from './operation/capture'
import {
  capsuleActorTypeEnum,
  capsuleOperationStatusEnum,
  capsuleOperationsTable,
  capsuleOperationTypeEnum,
  createCapsuleOperationsTable,
} from './operation/record'
import {
  capsuleOperationStepStatusEnum,
  capsuleOperationStepsTable,
  createCapsuleOperationStepsTable,
} from './operation/step'
import { capsuleLifecycleStatusEnum, capsulesTable, createCapsulesTable } from './record'
import {
  capsuleSnapshotDependencyDigestKindEnum,
  capsuleSnapshotDependencyKindEnum,
  capsuleSnapshotDependencyReferencesTable,
  createCapsuleSnapshotDependencyReferencesTable,
} from './snapshot/dependency'
import {
  capsuleSnapshotGitRemoteTransportEnum,
  capsuleSnapshotGitRemotesTable,
  capsuleSnapshotGitRepositoriesTable,
  createCapsuleSnapshotGitRemotesTable,
  createCapsuleSnapshotGitRepositoriesTable,
} from './snapshot/git'
import {
  capsuleArtifactEntriesTable,
  capsuleArtifactEntryTypeEnum,
  capsuleArtifactManifestRootsTable,
  capsuleArtifactManifestsTable,
  createCapsuleArtifactEntriesTable,
  createCapsuleArtifactManifestRootsTable,
  createCapsuleArtifactManifestsTable,
} from './snapshot/manifest'
import { capsuleSnapshotsTable, createCapsuleSnapshotsTable } from './snapshot/record'
import {
  capsuleSnapshotResourceKindEnum,
  capsuleSnapshotResourceProviderEnum,
  capsuleSnapshotResourceReferencesTable,
  createCapsuleSnapshotResourceReferencesTable,
} from './snapshot/resource'
import type { RelationFragmentManyFn, RelationFragmentOneFn } from '../relations'

export {
  capsuleActorTypeEnum,
  capsuleArtifactEntryTypeEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleLifecycleStatusEnum,
  capsuleOperationStatusEnum,
  capsuleOperationStepStatusEnum,
  capsuleOperationTypeEnum,
  capsuleSnapshotDependencyDigestKindEnum,
  capsuleSnapshotDependencyKindEnum,
  capsuleSnapshotGitRemoteTransportEnum,
  capsuleSnapshotResourceKindEnum,
  capsuleSnapshotResourceProviderEnum,
}

export function createCapsuleSchema<TUserIdColumn extends PgColumn>(userIdColumn: TUserIdColumn) {
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
  const capsuleSnapshotResourceReferences = createCapsuleSnapshotResourceReferencesTable(
    capsuleSnapshots.id,
    capsuleArtifactManifestRoots.id,
    capsuleBranchResources.id,
  )
  const capsuleSnapshotCaptureOperations = createCapsuleSnapshotCaptureOperationsTable(
    capsuleOperations.id,
    capsuleBranches.id,
    capsuleSnapshots.id,
  )
  return {
    capsules,
    capsuleBranches,
    capsuleOperations,
    capsuleCreateOperations,
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
  }
}

export const capsuleRuntimeSchema = {
  capsules: capsulesTable,
  capsuleBranches: capsuleBranchesTable,
  capsuleOperations: capsuleOperationsTable,
  capsuleCreateOperations: capsuleCreateOperationsTable,
  capsuleOperationSteps: capsuleOperationStepsTable,
  capsuleBranchResources: capsuleBranchResourcesTable,
  capsuleSnapshots: capsuleSnapshotsTable,
  capsuleArtifactManifests: capsuleArtifactManifestsTable,
  capsuleArtifactManifestRoots: capsuleArtifactManifestRootsTable,
  capsuleArtifactEntries: capsuleArtifactEntriesTable,
  capsuleSnapshotGitRepositories: capsuleSnapshotGitRepositoriesTable,
  capsuleSnapshotGitRemotes: capsuleSnapshotGitRemotesTable,
  capsuleSnapshotDependencyReferences: capsuleSnapshotDependencyReferencesTable,
  capsuleSnapshotResourceReferences: capsuleSnapshotResourceReferencesTable,
  capsuleSnapshotCaptureOperations: capsuleSnapshotCaptureOperationsTable,
} as const

export interface CapsuleRelationHelpers {
  one: {
    users: RelationFragmentOneFn<'users'>
    capsules: RelationFragmentOneFn<'capsules'>
    capsuleBranches: RelationFragmentOneFn<'capsuleBranches'>
    capsuleOperations: RelationFragmentOneFn<'capsuleOperations'>
    capsuleCreateOperations: RelationFragmentOneFn<'capsuleCreateOperations'>
    capsuleBranchResources: RelationFragmentOneFn<'capsuleBranchResources'>
    capsuleSnapshots: RelationFragmentOneFn<'capsuleSnapshots'>
    capsuleArtifactManifests: RelationFragmentOneFn<'capsuleArtifactManifests'>
    capsuleArtifactManifestRoots: RelationFragmentOneFn<'capsuleArtifactManifestRoots'>
    capsuleSnapshotGitRepositories: RelationFragmentOneFn<'capsuleSnapshotGitRepositories'>
    capsuleSnapshotCaptureOperations: RelationFragmentOneFn<'capsuleSnapshotCaptureOperations'>
  }
  many: {
    capsules: RelationFragmentManyFn<'capsules'>
    capsuleBranches: RelationFragmentManyFn<'capsuleBranches'>
    capsuleOperations: RelationFragmentManyFn<'capsuleOperations'>
    capsuleOperationSteps: RelationFragmentManyFn<'capsuleOperationSteps'>
    capsuleBranchResources: RelationFragmentManyFn<'capsuleBranchResources'>
    capsuleSnapshots: RelationFragmentManyFn<'capsuleSnapshots'>
    capsuleArtifactManifestRoots: RelationFragmentManyFn<'capsuleArtifactManifestRoots'>
    capsuleArtifactEntries: RelationFragmentManyFn<'capsuleArtifactEntries'>
    capsuleSnapshotGitRepositories: RelationFragmentManyFn<'capsuleSnapshotGitRepositories'>
    capsuleSnapshotGitRemotes: RelationFragmentManyFn<'capsuleSnapshotGitRemotes'>
    capsuleSnapshotDependencyReferences: RelationFragmentManyFn<'capsuleSnapshotDependencyReferences'>
    capsuleSnapshotResourceReferences: RelationFragmentManyFn<'capsuleSnapshotResourceReferences'>
    capsuleSnapshotCaptureOperations: RelationFragmentManyFn<'capsuleSnapshotCaptureOperations'>
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
  }
  capsuleCreateOperations: {
    operationId: RelationsBuilderColumnBase<'capsuleCreateOperations'>
    rootBranchId: RelationsBuilderColumnBase<'capsuleCreateOperations'>
  }
  capsuleOperationSteps: {
    ownerId: RelationsBuilderColumnBase<'capsuleOperationSteps'>
    capsuleId: RelationsBuilderColumnBase<'capsuleOperationSteps'>
    operationId: RelationsBuilderColumnBase<'capsuleOperationSteps'>
    branchId: RelationsBuilderColumnBase<'capsuleOperationSteps'>
  }
  capsuleBranchResources: {
    id: RelationsBuilderColumnBase<'capsuleBranchResources'>
    ownerId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    branchId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    createdByOperationId: RelationsBuilderColumnBase<'capsuleBranchResources'>
    lastOperationId: RelationsBuilderColumnBase<'capsuleBranchResources'>
  }
  capsuleSnapshots: {
    id: RelationsBuilderColumnBase<'capsuleSnapshots'>
    capsuleId: RelationsBuilderColumnBase<'capsuleSnapshots'>
    sourceBranchId: RelationsBuilderColumnBase<'capsuleSnapshots'>
  }
  capsuleArtifactManifests: {
    id: RelationsBuilderColumnBase<'capsuleArtifactManifests'>
    snapshotId: RelationsBuilderColumnBase<'capsuleArtifactManifests'>
  }
  capsuleArtifactManifestRoots: {
    id: RelationsBuilderColumnBase<'capsuleArtifactManifestRoots'>
    manifestId: RelationsBuilderColumnBase<'capsuleArtifactManifestRoots'>
  }
  capsuleArtifactEntries: {
    manifestRootId: RelationsBuilderColumnBase<'capsuleArtifactEntries'>
  }
  capsuleSnapshotGitRepositories: {
    id: RelationsBuilderColumnBase<'capsuleSnapshotGitRepositories'>
    snapshotId: RelationsBuilderColumnBase<'capsuleSnapshotGitRepositories'>
    manifestRootId: RelationsBuilderColumnBase<'capsuleSnapshotGitRepositories'>
  }
  capsuleSnapshotGitRemotes: {
    repositoryId: RelationsBuilderColumnBase<'capsuleSnapshotGitRemotes'>
  }
  capsuleSnapshotDependencyReferences: {
    snapshotId: RelationsBuilderColumnBase<'capsuleSnapshotDependencyReferences'>
    manifestRootId: RelationsBuilderColumnBase<'capsuleSnapshotDependencyReferences'>
    sourceBranchResourceId: RelationsBuilderColumnBase<'capsuleSnapshotDependencyReferences'>
  }
  capsuleSnapshotResourceReferences: {
    snapshotId: RelationsBuilderColumnBase<'capsuleSnapshotResourceReferences'>
    manifestRootId: RelationsBuilderColumnBase<'capsuleSnapshotResourceReferences'>
    sourceBranchResourceId: RelationsBuilderColumnBase<'capsuleSnapshotResourceReferences'>
  }
  capsuleSnapshotCaptureOperations: {
    operationId: RelationsBuilderColumnBase<'capsuleSnapshotCaptureOperations'>
    sourceBranchId: RelationsBuilderColumnBase<'capsuleSnapshotCaptureOperations'>
    snapshotId: RelationsBuilderColumnBase<'capsuleSnapshotCaptureOperations'>
  }
}

/**
 * Defines the complete capsule relation fragment owned by @qiln/core.
 *
 * Relations describe navigable ownership and provenance. Cross-table capture
 * completeness, canonical digest verification, policy satisfaction, and base
 * operation discriminator checks remain responsibilities of the future atomic
 * capture commit transaction.
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
      createOperation: helpers.one.capsuleCreateOperations({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleCreateOperations.rootBranchId,
        optional: true,
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
      snapshotCaptures: helpers.many.capsuleSnapshotCaptureOperations({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleSnapshotCaptureOperations.sourceBranchId,
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
      createOperation: helpers.one.capsuleCreateOperations({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleCreateOperations.operationId,
        optional: true,
      }),
      snapshotCaptureOperation: helpers.one.capsuleSnapshotCaptureOperations({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleSnapshotCaptureOperations.operationId,
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
    capsuleCreateOperations: {
      operation: helpers.one.capsuleOperations({
        from: helpers.capsuleCreateOperations.operationId,
        to: helpers.capsuleOperations.id,
        optional: false,
      }),
      rootBranch: helpers.one.capsuleBranches({
        from: helpers.capsuleCreateOperations.rootBranchId,
        to: helpers.capsuleBranches.id,
        optional: false,
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
      snapshotDependencies: helpers.many.capsuleSnapshotDependencyReferences({
        from: helpers.capsuleBranchResources.id,
        to: helpers.capsuleSnapshotDependencyReferences.sourceBranchResourceId,
      }),
      snapshotResources: helpers.many.capsuleSnapshotResourceReferences({
        from: helpers.capsuleBranchResources.id,
        to: helpers.capsuleSnapshotResourceReferences.sourceBranchResourceId,
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
      manifest: helpers.one.capsuleArtifactManifests({
        from: helpers.capsuleSnapshots.id,
        to: helpers.capsuleArtifactManifests.snapshotId,
        optional: false,
      }),
      captureOperation: helpers.one.capsuleSnapshotCaptureOperations({
        from: helpers.capsuleSnapshots.id,
        to: helpers.capsuleSnapshotCaptureOperations.snapshotId,
        optional: true,
      }),
      gitRepositories: helpers.many.capsuleSnapshotGitRepositories({
        from: helpers.capsuleSnapshots.id,
        to: helpers.capsuleSnapshotGitRepositories.snapshotId,
      }),
      dependencies: helpers.many.capsuleSnapshotDependencyReferences({
        from: helpers.capsuleSnapshots.id,
        to: helpers.capsuleSnapshotDependencyReferences.snapshotId,
      }),
      resourceReferences: helpers.many.capsuleSnapshotResourceReferences({
        from: helpers.capsuleSnapshots.id,
        to: helpers.capsuleSnapshotResourceReferences.snapshotId,
      }),
    },
    capsuleArtifactManifests: {
      snapshot: helpers.one.capsuleSnapshots({
        from: helpers.capsuleArtifactManifests.snapshotId,
        to: helpers.capsuleSnapshots.id,
        optional: false,
      }),
      roots: helpers.many.capsuleArtifactManifestRoots({
        from: helpers.capsuleArtifactManifests.id,
        to: helpers.capsuleArtifactManifestRoots.manifestId,
      }),
    },
    capsuleArtifactManifestRoots: {
      manifest: helpers.one.capsuleArtifactManifests({
        from: helpers.capsuleArtifactManifestRoots.manifestId,
        to: helpers.capsuleArtifactManifests.id,
        optional: false,
      }),
      entries: helpers.many.capsuleArtifactEntries({
        from: helpers.capsuleArtifactManifestRoots.id,
        to: helpers.capsuleArtifactEntries.manifestRootId,
      }),
      gitRepositories: helpers.many.capsuleSnapshotGitRepositories({
        from: helpers.capsuleArtifactManifestRoots.id,
        to: helpers.capsuleSnapshotGitRepositories.manifestRootId,
      }),
      dependencies: helpers.many.capsuleSnapshotDependencyReferences({
        from: helpers.capsuleArtifactManifestRoots.id,
        to: helpers.capsuleSnapshotDependencyReferences.manifestRootId,
      }),
      resourceReferences: helpers.many.capsuleSnapshotResourceReferences({
        from: helpers.capsuleArtifactManifestRoots.id,
        to: helpers.capsuleSnapshotResourceReferences.manifestRootId,
      }),
    },
    capsuleArtifactEntries: {
      root: helpers.one.capsuleArtifactManifestRoots({
        from: helpers.capsuleArtifactEntries.manifestRootId,
        to: helpers.capsuleArtifactManifestRoots.id,
        optional: false,
      }),
    },
    capsuleSnapshotGitRepositories: {
      snapshot: helpers.one.capsuleSnapshots({
        from: helpers.capsuleSnapshotGitRepositories.snapshotId,
        to: helpers.capsuleSnapshots.id,
        optional: false,
      }),
      root: helpers.one.capsuleArtifactManifestRoots({
        from: helpers.capsuleSnapshotGitRepositories.manifestRootId,
        to: helpers.capsuleArtifactManifestRoots.id,
        optional: false,
      }),
      remotes: helpers.many.capsuleSnapshotGitRemotes({
        from: helpers.capsuleSnapshotGitRepositories.id,
        to: helpers.capsuleSnapshotGitRemotes.repositoryId,
      }),
    },
    capsuleSnapshotGitRemotes: {
      repository: helpers.one.capsuleSnapshotGitRepositories({
        from: helpers.capsuleSnapshotGitRemotes.repositoryId,
        to: helpers.capsuleSnapshotGitRepositories.id,
        optional: false,
      }),
    },
    capsuleSnapshotDependencyReferences: {
      snapshot: helpers.one.capsuleSnapshots({
        from: helpers.capsuleSnapshotDependencyReferences.snapshotId,
        to: helpers.capsuleSnapshots.id,
        optional: false,
      }),
      root: helpers.one.capsuleArtifactManifestRoots({
        from: helpers.capsuleSnapshotDependencyReferences.manifestRootId,
        to: helpers.capsuleArtifactManifestRoots.id,
        optional: false,
      }),
      sourceResource: helpers.one.capsuleBranchResources({
        from: helpers.capsuleSnapshotDependencyReferences.sourceBranchResourceId,
        to: helpers.capsuleBranchResources.id,
        optional: false,
      }),
    },
    capsuleSnapshotResourceReferences: {
      snapshot: helpers.one.capsuleSnapshots({
        from: helpers.capsuleSnapshotResourceReferences.snapshotId,
        to: helpers.capsuleSnapshots.id,
        optional: false,
      }),
      root: helpers.one.capsuleArtifactManifestRoots({
        from: helpers.capsuleSnapshotResourceReferences.manifestRootId,
        to: helpers.capsuleArtifactManifestRoots.id,
        optional: false,
      }),
      sourceResource: helpers.one.capsuleBranchResources({
        from: helpers.capsuleSnapshotResourceReferences.sourceBranchResourceId,
        to: helpers.capsuleBranchResources.id,
        optional: false,
      }),
    },
    capsuleSnapshotCaptureOperations: {
      operation: helpers.one.capsuleOperations({
        from: helpers.capsuleSnapshotCaptureOperations.operationId,
        to: helpers.capsuleOperations.id,
        optional: false,
      }),
      sourceBranch: helpers.one.capsuleBranches({
        from: helpers.capsuleSnapshotCaptureOperations.sourceBranchId,
        to: helpers.capsuleBranches.id,
        optional: false,
      }),
      snapshot: helpers.one.capsuleSnapshots({
        from: helpers.capsuleSnapshotCaptureOperations.snapshotId,
        to: helpers.capsuleSnapshots.id,
        optional: true,
      }),
    },
  }
}

type CapsuleRuntimeRelations = ExtractTablesWithRelations<{}, ExtractTablesFromSchema<typeof capsuleRuntimeSchema>>

export type CapsuleHostDbContract = PostgresJsDatabase<CapsuleRuntimeRelations>
