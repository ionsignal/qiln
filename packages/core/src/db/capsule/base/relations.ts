import type { RelationsBuilderColumnBase } from 'drizzle-orm'
import type { RelationFragmentManyFn, RelationFragmentOneFn } from '../../relations'

export interface Helpers {
  one: {
    users: RelationFragmentOneFn<'users'>
    capsules: RelationFragmentOneFn<'capsules'>
    capsuleBranches: RelationFragmentOneFn<'capsuleBranches'>
    capsuleOperations: RelationFragmentOneFn<'capsuleOperations'>
    capsuleCreateOperations: RelationFragmentOneFn<'capsuleCreateOperations'>
    capsuleForkOperations: RelationFragmentOneFn<'capsuleForkOperations'>
    capsuleBranchRuntimeOperations: RelationFragmentOneFn<'capsuleBranchRuntimeOperations'>
    capsuleBranchResources: RelationFragmentOneFn<'capsuleBranchResources'>
    capsuleSnapshots: RelationFragmentOneFn<'capsuleSnapshots'>
    capsuleSnapshotCreateOperations: RelationFragmentOneFn<'capsuleSnapshotCreateOperations'>
    capsuleSnapshotCreateResources: RelationFragmentOneFn<'capsuleSnapshotCreateResources'>
    capsuleSnapshotResourceReferences: RelationFragmentOneFn<'capsuleSnapshotResourceReferences'>
  }
  many: {
    capsules: RelationFragmentManyFn<'capsules'>
    capsuleBranches: RelationFragmentManyFn<'capsuleBranches'>
    capsuleOperations: RelationFragmentManyFn<'capsuleOperations'>
    capsuleForkOperations: RelationFragmentManyFn<'capsuleForkOperations'>
    capsuleBranchRuntimeOperations: RelationFragmentManyFn<'capsuleBranchRuntimeOperations'>
    capsuleOperationSteps: RelationFragmentManyFn<'capsuleOperationSteps'>
    capsuleBranchResources: RelationFragmentManyFn<'capsuleBranchResources'>
    capsuleSnapshots: RelationFragmentManyFn<'capsuleSnapshots'>
    capsuleSnapshotCreateOperations: RelationFragmentManyFn<'capsuleSnapshotCreateOperations'>
    capsuleSnapshotCreateResources: RelationFragmentManyFn<'capsuleSnapshotCreateResources'>
    capsuleSnapshotResourceReferences: RelationFragmentManyFn<'capsuleSnapshotResourceReferences'>
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
  capsuleForkOperations: {
    operationId: RelationsBuilderColumnBase<'capsuleForkOperations'>
    sourceSnapshotId: RelationsBuilderColumnBase<'capsuleForkOperations'>
    targetBranchId: RelationsBuilderColumnBase<'capsuleForkOperations'>
  }
  capsuleBranchRuntimeOperations: {
    operationId: RelationsBuilderColumnBase<'capsuleBranchRuntimeOperations'>
    branchId: RelationsBuilderColumnBase<'capsuleBranchRuntimeOperations'>
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
  capsuleSnapshotCreateOperations: {
    operationId: RelationsBuilderColumnBase<'capsuleSnapshotCreateOperations'>
    sourceBranchId: RelationsBuilderColumnBase<'capsuleSnapshotCreateOperations'>
    snapshotId: RelationsBuilderColumnBase<'capsuleSnapshotCreateOperations'>
  }
  capsuleSnapshotCreateResources: {
    id: RelationsBuilderColumnBase<'capsuleSnapshotCreateResources'>
    operationId: RelationsBuilderColumnBase<'capsuleSnapshotCreateResources'>
    sourceBranchResourceId: RelationsBuilderColumnBase<'capsuleSnapshotCreateResources'>
  }
  capsuleSnapshotResourceReferences: {
    snapshotId: RelationsBuilderColumnBase<'capsuleSnapshotResourceReferences'>
    sourceBranchResourceId: RelationsBuilderColumnBase<'capsuleSnapshotResourceReferences'>
    createResourceId: RelationsBuilderColumnBase<'capsuleSnapshotResourceReferences'>
  }
}

/**
 * Defines the base capsule relation fragment.
 *
 * Relations describe navigable ownership and provenance. Complete
 * managed-volume coverage, Blueprint and rootfs pin verification, provider
 * outcomes, and base operation discriminator agreement remain
 * operation-specific transaction responsibilities.
 */
export function defineRelations(helpers: Helpers) {
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
      forkOperation: helpers.one.capsuleForkOperations({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleForkOperations.targetBranchId,
        optional: true,
      }),
      runtimeOperations: helpers.many.capsuleBranchRuntimeOperations({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleBranchRuntimeOperations.branchId,
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
      snapshotCreates: helpers.many.capsuleSnapshotCreateOperations({
        from: helpers.capsuleBranches.id,
        to: helpers.capsuleSnapshotCreateOperations.sourceBranchId,
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
      forkOperation: helpers.one.capsuleForkOperations({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleForkOperations.operationId,
        optional: true,
      }),
      branchRuntimeOperation: helpers.one.capsuleBranchRuntimeOperations({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleBranchRuntimeOperations.operationId,
        optional: true,
      }),
      snapshotCreateOperation: helpers.one.capsuleSnapshotCreateOperations({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleSnapshotCreateOperations.operationId,
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
    capsuleForkOperations: {
      operation: helpers.one.capsuleOperations({
        from: helpers.capsuleForkOperations.operationId,
        to: helpers.capsuleOperations.id,
        optional: false,
      }),
      sourceSnapshot: helpers.one.capsuleSnapshots({
        from: helpers.capsuleForkOperations.sourceSnapshotId,
        to: helpers.capsuleSnapshots.id,
        optional: false,
      }),
      targetBranch: helpers.one.capsuleBranches({
        from: helpers.capsuleForkOperations.targetBranchId,
        to: helpers.capsuleBranches.id,
        optional: false,
      }),
    },
    capsuleBranchRuntimeOperations: {
      operation: helpers.one.capsuleOperations({
        from: helpers.capsuleBranchRuntimeOperations.operationId,
        to: helpers.capsuleOperations.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.capsuleBranchRuntimeOperations.branchId,
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
      snapshotResources: helpers.many.capsuleSnapshotResourceReferences({
        from: helpers.capsuleBranchResources.id,
        to: helpers.capsuleSnapshotResourceReferences.sourceBranchResourceId,
      }),
      snapshotCreateResources: helpers.many.capsuleSnapshotCreateResources({
        from: helpers.capsuleBranchResources.id,
        to: helpers.capsuleSnapshotCreateResources.sourceBranchResourceId,
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
      createOperation: helpers.one.capsuleSnapshotCreateOperations({
        from: helpers.capsuleSnapshots.id,
        to: helpers.capsuleSnapshotCreateOperations.snapshotId,
        optional: false,
      }),
      forks: helpers.many.capsuleForkOperations({
        from: helpers.capsuleSnapshots.id,
        to: helpers.capsuleForkOperations.sourceSnapshotId,
      }),
      resourceReferences: helpers.many.capsuleSnapshotResourceReferences({
        from: helpers.capsuleSnapshots.id,
        to: helpers.capsuleSnapshotResourceReferences.snapshotId,
      }),
    },
    capsuleSnapshotCreateOperations: {
      operation: helpers.one.capsuleOperations({
        from: helpers.capsuleSnapshotCreateOperations.operationId,
        to: helpers.capsuleOperations.id,
        optional: false,
      }),
      sourceBranch: helpers.one.capsuleBranches({
        from: helpers.capsuleSnapshotCreateOperations.sourceBranchId,
        to: helpers.capsuleBranches.id,
        optional: false,
      }),
      snapshot: helpers.one.capsuleSnapshots({
        from: helpers.capsuleSnapshotCreateOperations.snapshotId,
        to: helpers.capsuleSnapshots.id,
        optional: true,
      }),
      resources: helpers.many.capsuleSnapshotCreateResources({
        from: helpers.capsuleSnapshotCreateOperations.operationId,
        to: helpers.capsuleSnapshotCreateResources.operationId,
      }),
    },
    capsuleSnapshotCreateResources: {
      operation: helpers.one.capsuleSnapshotCreateOperations({
        from: helpers.capsuleSnapshotCreateResources.operationId,
        to: helpers.capsuleSnapshotCreateOperations.operationId,
        optional: false,
      }),
      sourceResource: helpers.one.capsuleBranchResources({
        from: helpers.capsuleSnapshotCreateResources.sourceBranchResourceId,
        to: helpers.capsuleBranchResources.id,
        optional: false,
      }),
      snapshotResourceReference: helpers.one.capsuleSnapshotResourceReferences({
        from: helpers.capsuleSnapshotCreateResources.id,
        to: helpers.capsuleSnapshotResourceReferences.createResourceId,
        optional: true,
      }),
    },
    capsuleSnapshotResourceReferences: {
      snapshot: helpers.one.capsuleSnapshots({
        from: helpers.capsuleSnapshotResourceReferences.snapshotId,
        to: helpers.capsuleSnapshots.id,
        optional: false,
      }),
      sourceResource: helpers.one.capsuleBranchResources({
        from: helpers.capsuleSnapshotResourceReferences.sourceBranchResourceId,
        to: helpers.capsuleBranchResources.id,
        optional: false,
      }),
      createResource: helpers.one.capsuleSnapshotCreateResources({
        from: helpers.capsuleSnapshotResourceReferences.createResourceId,
        to: helpers.capsuleSnapshotCreateResources.id,
        optional: false,
      }),
    },
  }
}
