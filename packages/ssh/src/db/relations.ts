import type { RelationsBuilderColumnBase } from 'drizzle-orm'
import type { RelationFragmentManyFn, RelationFragmentOneFn } from '@qiln/core/server'

interface RelationColumns {
  users: 'id'
  capsules: 'id'
  capsuleBranches: 'id'
  sshPublicKeys: 'id' | 'ownerUserId'
  sshBranchAccess: 'branchId'
  sshBranchGrants:
    | 'id'
    | 'publicKeyId'
    | 'keyOwnerUserId'
    | 'capsuleOwnerUserId'
    | 'boundByAdminUserId'
    | 'revokedByUserId'
    | 'capsuleId'
    | 'branchId'
  sshTickets: 'id' | 'publicKeyId' | 'grantId' | 'userId' | 'capsuleId' | 'branchId'
  sshRelays: 'ticketId' | 'publicKeyId' | 'userId' | 'capsuleId' | 'branchId'
}

export type SshRelationHelpers = {
  one: {
    [TTable in keyof RelationColumns]: RelationFragmentOneFn<TTable>
  }
  many: {
    [TTable in keyof RelationColumns]: RelationFragmentManyFn<TTable>
  }
} & {
  [TTable in keyof RelationColumns]: {
    [TColumn in RelationColumns[TTable]]: RelationsBuilderColumnBase<TTable>
  }
}

/**
 * Contributes SSH relations to the Host's final Drizzle v1 relation graph.
 *
 * Relations expose durable identity and audit links. Transactional ownership,
 * administrator, eligibility, ticket, and relay checks remain policy concerns.
 */
export function defineSshRelations(helpers: SshRelationHelpers) {
  return {
    users: {
      sshPublicKeys: helpers.many.sshPublicKeys(),
      sshBranchGrantsAsKeyOwner: helpers.many.sshBranchGrants({
        from: helpers.users.id,
        to: helpers.sshBranchGrants.keyOwnerUserId,
      }),
      sshBranchGrantsAsCapsuleOwner: helpers.many.sshBranchGrants({
        from: helpers.users.id,
        to: helpers.sshBranchGrants.capsuleOwnerUserId,
      }),
      sshBranchGrantsBoundAsAdmin: helpers.many.sshBranchGrants({
        from: helpers.users.id,
        to: helpers.sshBranchGrants.boundByAdminUserId,
      }),
      sshBranchGrantsRevoked: helpers.many.sshBranchGrants({
        from: helpers.users.id,
        to: helpers.sshBranchGrants.revokedByUserId,
      }),
      sshTickets: helpers.many.sshTickets(),
      sshRelays: helpers.many.sshRelays(),
    },
    capsules: {
      sshBranchGrants: helpers.many.sshBranchGrants(),
      sshTickets: helpers.many.sshTickets(),
      sshRelays: helpers.many.sshRelays(),
    },
    capsuleBranches: {
      sshAccess: helpers.one.sshBranchAccess({
        from: helpers.capsuleBranches.id,
        to: helpers.sshBranchAccess.branchId,
        optional: true,
      }),
      sshGrants: helpers.many.sshBranchGrants(),
      sshTickets: helpers.many.sshTickets(),
      sshRelays: helpers.many.sshRelays(),
    },
    sshPublicKeys: {
      owner: helpers.one.users({
        from: helpers.sshPublicKeys.ownerUserId,
        to: helpers.users.id,
        optional: false,
      }),
      grants: helpers.many.sshBranchGrants(),
      tickets: helpers.many.sshTickets(),
      relays: helpers.many.sshRelays(),
    },
    sshBranchAccess: {
      branch: helpers.one.capsuleBranches({
        from: helpers.sshBranchAccess.branchId,
        to: helpers.capsuleBranches.id,
        optional: false,
      }),
    },
    sshBranchGrants: {
      publicKey: helpers.one.sshPublicKeys({
        from: helpers.sshBranchGrants.publicKeyId,
        to: helpers.sshPublicKeys.id,
        optional: false,
      }),
      keyOwner: helpers.one.users({
        from: helpers.sshBranchGrants.keyOwnerUserId,
        to: helpers.users.id,
        optional: false,
      }),
      capsuleOwner: helpers.one.users({
        from: helpers.sshBranchGrants.capsuleOwnerUserId,
        to: helpers.users.id,
        optional: false,
      }),
      boundByAdmin: helpers.one.users({
        from: helpers.sshBranchGrants.boundByAdminUserId,
        to: helpers.users.id,
        optional: false,
      }),
      revokedByUser: helpers.one.users({
        from: helpers.sshBranchGrants.revokedByUserId,
        to: helpers.users.id,
        optional: true,
      }),
      capsule: helpers.one.capsules({
        from: helpers.sshBranchGrants.capsuleId,
        to: helpers.capsules.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.sshBranchGrants.branchId,
        to: helpers.capsuleBranches.id,
        optional: false,
      }),
      tickets: helpers.many.sshTickets(),
    },
    sshTickets: {
      publicKey: helpers.one.sshPublicKeys({
        from: helpers.sshTickets.publicKeyId,
        to: helpers.sshPublicKeys.id,
        optional: false,
      }),
      grant: helpers.one.sshBranchGrants({
        from: helpers.sshTickets.grantId,
        to: helpers.sshBranchGrants.id,
        optional: false,
      }),
      user: helpers.one.users({
        from: helpers.sshTickets.userId,
        to: helpers.users.id,
        optional: false,
      }),
      capsule: helpers.one.capsules({
        from: helpers.sshTickets.capsuleId,
        to: helpers.capsules.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.sshTickets.branchId,
        to: helpers.capsuleBranches.id,
        optional: false,
      }),
      relay: helpers.one.sshRelays({
        from: helpers.sshTickets.id,
        to: helpers.sshRelays.ticketId,
        optional: true,
      }),
    },
    sshRelays: {
      ticket: helpers.one.sshTickets({
        from: helpers.sshRelays.ticketId,
        to: helpers.sshTickets.id,
        optional: false,
      }),
      publicKey: helpers.one.sshPublicKeys({
        from: helpers.sshRelays.publicKeyId,
        to: helpers.sshPublicKeys.id,
        optional: false,
      }),
      user: helpers.one.users({
        from: helpers.sshRelays.userId,
        to: helpers.users.id,
        optional: false,
      }),
      capsule: helpers.one.capsules({
        from: helpers.sshRelays.capsuleId,
        to: helpers.capsules.id,
        optional: false,
      }),
      branch: helpers.one.capsuleBranches({
        from: helpers.sshRelays.branchId,
        to: helpers.capsuleBranches.id,
        optional: false,
      }),
    },
  }
}
