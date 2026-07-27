import type { RelationsBuilderColumnBase } from 'drizzle-orm'
import type { RelationFragmentManyFn, RelationFragmentOneFn } from '../../relations'

export interface Helpers {
  one: {
    users: RelationFragmentOneFn<'users'>
    capsules: RelationFragmentOneFn<'capsules'>
    capsuleOperations: RelationFragmentOneFn<'capsuleOperations'>
    capsuleSnapshots: RelationFragmentOneFn<'capsuleSnapshots'>
    capsuleRouteAliases: RelationFragmentOneFn<'capsuleRouteAliases'>
    capsuleRouteHeads: RelationFragmentOneFn<'capsuleRouteHeads'>
    capsuleRouteRevisions: RelationFragmentOneFn<'capsuleRouteRevisions'>
    capsuleRouteOperations: RelationFragmentOneFn<'capsuleRouteOperations'>
    capsuleRouteProviderApplications: RelationFragmentOneFn<'capsuleRouteProviderApplications'>
  }
  many: {
    capsuleRouteAliases: RelationFragmentManyFn<'capsuleRouteAliases'>
    capsuleRouteRevisions: RelationFragmentManyFn<'capsuleRouteRevisions'>
    capsuleRouteOperations: RelationFragmentManyFn<'capsuleRouteOperations'>
  }
  users: {
    id: RelationsBuilderColumnBase<'users'>
  }
  capsules: {
    id: RelationsBuilderColumnBase<'capsules'>
  }
  capsuleOperations: {
    id: RelationsBuilderColumnBase<'capsuleOperations'>
  }
  capsuleSnapshots: {
    id: RelationsBuilderColumnBase<'capsuleSnapshots'>
  }
  capsuleRouteAliases: {
    id: RelationsBuilderColumnBase<'capsuleRouteAliases'>
    ownerId: RelationsBuilderColumnBase<'capsuleRouteAliases'>
    capsuleId: RelationsBuilderColumnBase<'capsuleRouteAliases'>
    mutationOperationId: RelationsBuilderColumnBase<'capsuleRouteAliases'>
    lastOperationId: RelationsBuilderColumnBase<'capsuleRouteAliases'>
  }
  capsuleRouteHeads: {
    aliasId: RelationsBuilderColumnBase<'capsuleRouteHeads'>
    revisionId: RelationsBuilderColumnBase<'capsuleRouteHeads'>
  }
  capsuleRouteRevisions: {
    id: RelationsBuilderColumnBase<'capsuleRouteRevisions'>
    aliasId: RelationsBuilderColumnBase<'capsuleRouteRevisions'>
    previousRevisionId: RelationsBuilderColumnBase<'capsuleRouteRevisions'>
    rollbackSourceRevisionId: RelationsBuilderColumnBase<'capsuleRouteRevisions'>
    snapshotId: RelationsBuilderColumnBase<'capsuleRouteRevisions'>
    operationId: RelationsBuilderColumnBase<'capsuleRouteRevisions'>
  }
  capsuleRouteOperations: {
    operationId: RelationsBuilderColumnBase<'capsuleRouteOperations'>
    aliasId: RelationsBuilderColumnBase<'capsuleRouteOperations'>
    expectedRevisionId: RelationsBuilderColumnBase<'capsuleRouteOperations'>
    proposedRevisionId: RelationsBuilderColumnBase<'capsuleRouteOperations'>
    rollbackSourceRevisionId: RelationsBuilderColumnBase<'capsuleRouteOperations'>
  }
  capsuleRouteProviderApplications: {
    operationId: RelationsBuilderColumnBase<'capsuleRouteProviderApplications'>
    revisionId: RelationsBuilderColumnBase<'capsuleRouteProviderApplications'>
  }
}

/**
 * Defines the capsule routing relation fragment.
 *
 * Cross-table target-pin verification, alias-head consistency, operation
 * discriminator agreement, approval policy, and provider finalization remain
 * responsibilities of route-specific Worker transactions.
 */
export function defineRelations(helpers: Helpers) {
  return {
    users: {
      routeAliases: helpers.many.capsuleRouteAliases({
        from: helpers.users.id,
        to: helpers.capsuleRouteAliases.ownerId,
      }),
    },
    capsules: {
      routeAliases: helpers.many.capsuleRouteAliases({
        from: helpers.capsules.id,
        to: helpers.capsuleRouteAliases.capsuleId,
      }),
    },
    capsuleOperations: {
      routeOperation: helpers.one.capsuleRouteOperations({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleRouteOperations.operationId,
        optional: true,
      }),
      routeRevision: helpers.one.capsuleRouteRevisions({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleRouteRevisions.operationId,
        optional: true,
      }),
      routeProviderApplication: helpers.one.capsuleRouteProviderApplications({
        from: helpers.capsuleOperations.id,
        to: helpers.capsuleRouteProviderApplications.operationId,
        optional: true,
      }),
    },
    capsuleSnapshots: {
      routeRevisions: helpers.many.capsuleRouteRevisions({
        from: helpers.capsuleSnapshots.id,
        to: helpers.capsuleRouteRevisions.snapshotId,
      }),
    },
    capsuleRouteAliases: {
      owner: helpers.one.users({
        from: helpers.capsuleRouteAliases.ownerId,
        to: helpers.users.id,
        optional: false,
      }),
      capsule: helpers.one.capsules({
        from: helpers.capsuleRouteAliases.capsuleId,
        to: helpers.capsules.id,
        optional: false,
      }),
      mutationOperation: helpers.one.capsuleOperations({
        from: helpers.capsuleRouteAliases.mutationOperationId,
        to: helpers.capsuleOperations.id,
        optional: true,
      }),
      lastOperation: helpers.one.capsuleOperations({
        from: helpers.capsuleRouteAliases.lastOperationId,
        to: helpers.capsuleOperations.id,
        optional: true,
      }),
      head: helpers.one.capsuleRouteHeads({
        from: helpers.capsuleRouteAliases.id,
        to: helpers.capsuleRouteHeads.aliasId,
        optional: true,
      }),
      revisions: helpers.many.capsuleRouteRevisions({
        from: helpers.capsuleRouteAliases.id,
        to: helpers.capsuleRouteRevisions.aliasId,
      }),
      operations: helpers.many.capsuleRouteOperations({
        from: helpers.capsuleRouteAliases.id,
        to: helpers.capsuleRouteOperations.aliasId,
      }),
    },
    capsuleRouteHeads: {
      alias: helpers.one.capsuleRouteAliases({
        from: helpers.capsuleRouteHeads.aliasId,
        to: helpers.capsuleRouteAliases.id,
        optional: false,
      }),
      revision: helpers.one.capsuleRouteRevisions({
        from: helpers.capsuleRouteHeads.revisionId,
        to: helpers.capsuleRouteRevisions.id,
        optional: false,
      }),
    },
    capsuleRouteRevisions: {
      alias: helpers.one.capsuleRouteAliases({
        from: helpers.capsuleRouteRevisions.aliasId,
        to: helpers.capsuleRouteAliases.id,
        optional: false,
      }),
      previous: helpers.one.capsuleRouteRevisions({
        from: helpers.capsuleRouteRevisions.previousRevisionId,
        to: helpers.capsuleRouteRevisions.id,
        optional: true,
      }),
      next: helpers.many.capsuleRouteRevisions({
        from: helpers.capsuleRouteRevisions.id,
        to: helpers.capsuleRouteRevisions.previousRevisionId,
      }),
      rollbackSource: helpers.one.capsuleRouteRevisions({
        from: helpers.capsuleRouteRevisions.rollbackSourceRevisionId,
        to: helpers.capsuleRouteRevisions.id,
        optional: true,
      }),
      rollbacks: helpers.many.capsuleRouteRevisions({
        from: helpers.capsuleRouteRevisions.id,
        to: helpers.capsuleRouteRevisions.rollbackSourceRevisionId,
      }),
      snapshot: helpers.one.capsuleSnapshots({
        from: helpers.capsuleRouteRevisions.snapshotId,
        to: helpers.capsuleSnapshots.id,
        optional: false,
      }),
      operation: helpers.one.capsuleOperations({
        from: helpers.capsuleRouteRevisions.operationId,
        to: helpers.capsuleOperations.id,
        optional: false,
      }),
      operationExtension: helpers.one.capsuleRouteOperations({
        from: helpers.capsuleRouteRevisions.id,
        to: helpers.capsuleRouteOperations.proposedRevisionId,
        optional: false,
      }),
      providerApplication: helpers.one.capsuleRouteProviderApplications({
        from: helpers.capsuleRouteRevisions.id,
        to: helpers.capsuleRouteProviderApplications.revisionId,
        optional: true,
      }),
      head: helpers.one.capsuleRouteHeads({
        from: helpers.capsuleRouteRevisions.id,
        to: helpers.capsuleRouteHeads.revisionId,
        optional: true,
      }),
    },
    capsuleRouteOperations: {
      operation: helpers.one.capsuleOperations({
        from: helpers.capsuleRouteOperations.operationId,
        to: helpers.capsuleOperations.id,
        optional: false,
      }),
      alias: helpers.one.capsuleRouteAliases({
        from: helpers.capsuleRouteOperations.aliasId,
        to: helpers.capsuleRouteAliases.id,
        optional: false,
      }),
      expectedRevision: helpers.one.capsuleRouteRevisions({
        from: helpers.capsuleRouteOperations.expectedRevisionId,
        to: helpers.capsuleRouteRevisions.id,
        optional: true,
      }),
      proposedRevision: helpers.one.capsuleRouteRevisions({
        from: helpers.capsuleRouteOperations.proposedRevisionId,
        to: helpers.capsuleRouteRevisions.id,
        optional: false,
      }),
      rollbackSource: helpers.one.capsuleRouteRevisions({
        from: helpers.capsuleRouteOperations.rollbackSourceRevisionId,
        to: helpers.capsuleRouteRevisions.id,
        optional: true,
      }),
    },
    capsuleRouteProviderApplications: {
      operation: helpers.one.capsuleOperations({
        from: helpers.capsuleRouteProviderApplications.operationId,
        to: helpers.capsuleOperations.id,
        optional: false,
      }),
      revision: helpers.one.capsuleRouteRevisions({
        from: helpers.capsuleRouteProviderApplications.revisionId,
        to: helpers.capsuleRouteRevisions.id,
        optional: false,
      }),
    },
  }
}
