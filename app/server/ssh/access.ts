import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  SshBranchAccessState,
  SshBranchAccessSummarySchema,
  SshBranchGrantStatus,
  SshTicketStatus,
  type SshBranchAccessInitializationReason,
  type SshBranchAccessMutationOutput,
  type SshBranchAccessRevocationReason,
  type SshBranchAccessSummary,
  type SshCapsuleAccessRevocationOutput,
  type SshCapsuleAccessRevocationReason,
} from '@qiln/core/server'
import { capsules, capsuleBranches, sshBranchAccess, sshBranchGrants, sshTickets } from '@server/db/schema'
import { sshConflict, sshNotFound, toIsoTimestamp, toNullableIsoTimestamp } from './errors'
import type { Database } from '@server/db'
import type { SshRelayCoordinator } from './relays'
import type { SshAuthorizedKeysSyncDispatcher } from './sync'

interface AccessRevocationTransactionResult {
  accesses: Array<{
    access: typeof sshBranchAccess.$inferSelect
    branch: Pick<typeof capsuleBranches.$inferSelect, 'id' | 'capsuleId' | 'name'>
  }>
  changed: boolean
  revokedGrantCount: number
  revokedTicketCount: number
  relayIds: string[]
}

export class SshBranchAccessService {
  constructor(
    private readonly db: Database,
    private readonly relays: SshRelayCoordinator,
    private readonly authorizedKeysSync: SshAuthorizedKeysSyncDispatcher,
  ) {}

  public async initializeBlocked(
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
    reason: SshBranchAccessInitializationReason,
  ): Promise<SshBranchAccessMutationOutput> {
    return await this.db.transaction(async tx => {
      const branch = await this.lockOwnedBranch(tx, ownerUserId, capsuleId, branchId)
      const [existing] = await tx
        .select()
        .from(sshBranchAccess)
        .where(eq(sshBranchAccess.branchId, branch.id))
        .for('update')
        .limit(1)

      if (existing) {
        if (existing.state !== SshBranchAccessState.BLOCKED || existing.blockReason !== reason) {
          throw sshConflict('The branch SSH access fence has already been initialized with different state.', {
            branchId,
            state: existing.state,
            blockReason: existing.blockReason,
          })
        }

        return {
          access: this.summary(existing, branch),
          changed: false,
          revocation: null,
        }
      }

      const now = new Date()
      const [created] = await tx
        .insert(sshBranchAccess)
        .values({
          branchId: branch.id,
          state: SshBranchAccessState.BLOCKED,
          blockReason: reason,
          enabledAt: null,
          blockedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()

      if (!created) {
        throw sshConflict('Failed to initialize the blocked branch SSH access fence.', {
          branchId,
        })
      }

      return {
        access: this.summary(created, branch),
        changed: true,
        revocation: null,
      }
    })
  }

  public async enable(
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<SshBranchAccessMutationOutput> {
    return await this.db.transaction(async tx => {
      const branch = await this.lockOwnedBranch(tx, ownerUserId, capsuleId, branchId)
      const capsule = await this.lockOwnedCapsule(tx, ownerUserId, capsuleId)
      const [access] = await tx
        .select()
        .from(sshBranchAccess)
        .where(eq(sshBranchAccess.branchId, branch.id))
        .for('update')
        .limit(1)

      if (!access) {
        throw sshConflict('The branch SSH access fence has not been initialized.', {
          branchId,
        })
      }

      if (branch.status !== 'online' || capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null) {
        throw sshConflict('SSH access can be enabled only after the editable branch is confirmed online.', {
          branchId,
          branchStatus: branch.status,
          capsuleLifecycleStatus: capsule.lifecycleStatus,
          capsuleArchived: capsule.archivedAt !== null,
        })
      }

      if (access.state === SshBranchAccessState.ENABLED) {
        return {
          access: this.summary(access, branch),
          changed: false,
          revocation: null,
        }
      }

      const now = new Date()
      const [enabled] = await tx
        .update(sshBranchAccess)
        .set({
          state: SshBranchAccessState.ENABLED,
          blockReason: null,
          enabledAt: now,
          updatedAt: now,
        })
        .where(and(eq(sshBranchAccess.branchId, branch.id), eq(sshBranchAccess.state, SshBranchAccessState.BLOCKED)))
        .returning()

      if (!enabled) {
        throw sshConflict('Branch SSH access enablement conflicted with another state transition.', {
          branchId,
        })
      }

      return {
        access: this.summary(enabled, branch),
        changed: true,
        revocation: null,
      }
    })
  }

  public async revokeBranch(
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
    reason: SshBranchAccessRevocationReason,
  ): Promise<SshBranchAccessMutationOutput> {
    const transaction = await this.revokeBranches(ownerUserId, capsuleId, [branchId], reason)
    this.authorizedKeysSync.scheduleBranch(ownerUserId, capsuleId, branchId)
    const closedRelayCount = await this.relays.confirmRelayClosures(transaction.relayIds)
    const record = transaction.accesses[0]

    if (!record) {
      throw sshConflict('Branch SSH access revocation returned no branch access state.', {
        branchId,
      })
    }

    return {
      access: this.summary(record.access, record.branch),
      changed: transaction.changed,
      revocation: {
        revokedGrantCount: transaction.revokedGrantCount,
        revokedTicketCount: transaction.revokedTicketCount,
        closedRelayCount,
        relayClosureConfirmed: true,
      },
    }
  }

  public async revokeCapsule(
    ownerUserId: string,
    capsuleId: string,
    reason: SshCapsuleAccessRevocationReason,
  ): Promise<SshCapsuleAccessRevocationOutput> {
    const branches = await this.db
      .select({
        id: capsuleBranches.id,
      })
      .from(capsuleBranches)
      .where(and(eq(capsuleBranches.ownerId, ownerUserId), eq(capsuleBranches.capsuleId, capsuleId)))
      .orderBy(asc(capsuleBranches.id))

    if (branches.length === 0) {
      throw sshNotFound('Capsule branches were not found for SSH access revocation.', {
        capsuleId,
      })
    }

    const transaction = await this.revokeBranches(
      ownerUserId,
      capsuleId,
      branches.map(branch => branch.id),
      reason,
    )

    for (const record of transaction.accesses) {
      this.authorizedKeysSync.scheduleBranch(ownerUserId, record.branch.capsuleId, record.branch.id)
    }

    const closedRelayCount = await this.relays.confirmRelayClosures(transaction.relayIds)

    return {
      capsuleId,
      branchAccess: transaction.accesses.map(record => this.summary(record.access, record.branch)),
      changed: transaction.changed,
      revocation: {
        revokedGrantCount: transaction.revokedGrantCount,
        revokedTicketCount: transaction.revokedTicketCount,
        closedRelayCount,
        relayClosureConfirmed: true,
      },
    }
  }

  private async revokeBranches(
    ownerUserId: string,
    capsuleId: string,
    branchIds: readonly string[],
    reason: SshBranchAccessRevocationReason | SshCapsuleAccessRevocationReason,
  ): Promise<AccessRevocationTransactionResult> {
    return await this.db.transaction(async tx => {
      await this.lockOwnedCapsule(tx, ownerUserId, capsuleId)

      const branches = await tx
        .select({
          id: capsuleBranches.id,
          capsuleId: capsuleBranches.capsuleId,
          name: capsuleBranches.name,
          ownerId: capsuleBranches.ownerId,
        })
        .from(capsuleBranches)
        .where(
          and(
            inArray(capsuleBranches.id, [...branchIds]),
            eq(capsuleBranches.ownerId, ownerUserId),
            eq(capsuleBranches.capsuleId, capsuleId),
          ),
        )
        .orderBy(asc(capsuleBranches.id))
        .for('update')

      if (branches.length !== branchIds.length) {
        throw sshNotFound('One or more capsule branches were not found for SSH access revocation.', {
          capsuleId,
          expectedBranchCount: branchIds.length,
          actualBranchCount: branches.length,
        })
      }

      const accessRows = await tx
        .select()
        .from(sshBranchAccess)
        .where(inArray(sshBranchAccess.branchId, [...branchIds]))
        .orderBy(asc(sshBranchAccess.branchId))
        .for('update')

      if (accessRows.length !== branchIds.length) {
        throw sshConflict('One or more branch SSH access fences have not been initialized.', {
          capsuleId,
          expectedAccessCount: branchIds.length,
          actualAccessCount: accessRows.length,
        })
      }

      const now = new Date()
      const enabledIds = accessRows
        .filter(access => access.state === SshBranchAccessState.ENABLED)
        .map(access => access.branchId)

      if (enabledIds.length > 0) {
        const blocked = await tx
          .update(sshBranchAccess)
          .set({
            state: SshBranchAccessState.BLOCKED,
            blockReason: reason,
            blockedAt: now,
            updatedAt: now,
          })
          .where(
            and(inArray(sshBranchAccess.branchId, enabledIds), eq(sshBranchAccess.state, SshBranchAccessState.ENABLED)),
          )
          .returning({
            branchId: sshBranchAccess.branchId,
          })

        if (blocked.length !== enabledIds.length) {
          throw sshConflict('Branch SSH access blocking conflicted with another state transition.')
        }
      }

      const differentlyBlockedIds = accessRows
        .filter(
          access =>
            access.state === SshBranchAccessState.BLOCKED &&
            (access.blockReason !== reason || access.blockedAt === null),
        )
        .map(access => access.branchId)

      if (differentlyBlockedIds.length > 0) {
        await tx
          .update(sshBranchAccess)
          .set({
            blockReason: reason,
            blockedAt: now,
            updatedAt: now,
          })
          .where(inArray(sshBranchAccess.branchId, differentlyBlockedIds))
      }

      const revokedGrants = await tx
        .update(sshBranchGrants)
        .set({
          status: SshBranchGrantStatus.REVOKED,
          revokedByUserId: null,
          revokedAt: now,
        })
        .where(
          and(
            inArray(sshBranchGrants.branchId, [...branchIds]),
            eq(sshBranchGrants.status, SshBranchGrantStatus.ACTIVE),
          ),
        )
        .returning({
          id: sshBranchGrants.id,
        })

      const revokedTickets = await tx
        .update(sshTickets)
        .set({
          status: SshTicketStatus.REVOKED,
          revokedAt: now,
        })
        .where(
          and(
            inArray(sshTickets.branchId, [...branchIds]),
            inArray(sshTickets.status, [SshTicketStatus.ISSUED, SshTicketStatus.REDEEMED]),
          ),
        )
        .returning({
          id: sshTickets.id,
        })

      const relayIds = await this.relays.markBranchRelaysClosing(tx, branchIds, reason)

      const committedAccess = await tx
        .select()
        .from(sshBranchAccess)
        .where(inArray(sshBranchAccess.branchId, [...branchIds]))
        .orderBy(asc(sshBranchAccess.branchId))

      const branchesById = new Map(branches.map(branch => [branch.id, branch] as const))

      return {
        accesses: committedAccess.map(access => {
          const branch = branchesById.get(access.branchId)
          if (!branch) {
            throw sshConflict('Committed SSH access state cannot resolve its branch.', {
              branchId: access.branchId,
            })
          }
          return {
            access,
            branch,
          }
        }),
        changed:
          enabledIds.length > 0 ||
          differentlyBlockedIds.length > 0 ||
          revokedGrants.length > 0 ||
          revokedTickets.length > 0 ||
          relayIds.length > 0,
        revokedGrantCount: revokedGrants.length,
        revokedTicketCount: revokedTickets.length,
        relayIds,
      }
    })
  }

  private async lockOwnedBranch(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
  ) {
    const [branch] = await tx
      .select()
      .from(capsuleBranches)
      .where(
        and(
          eq(capsuleBranches.id, branchId),
          eq(capsuleBranches.ownerId, ownerUserId),
          eq(capsuleBranches.capsuleId, capsuleId),
        ),
      )
      .for('update')
      .limit(1)

    if (!branch) {
      throw sshNotFound('Capsule branch not found or access denied.', {
        capsuleId,
        branchId,
      })
    }

    return branch
  }

  private async lockOwnedCapsule(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    ownerUserId: string,
    capsuleId: string,
  ) {
    const [capsule] = await tx
      .select()
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerUserId)))
      .for('update')
      .limit(1)

    if (!capsule) {
      throw sshNotFound('Capsule not found or access denied.', {
        capsuleId,
      })
    }

    return capsule
  }

  private summary(
    access: typeof sshBranchAccess.$inferSelect,
    branch: Pick<typeof capsuleBranches.$inferSelect, 'id' | 'capsuleId' | 'name'>,
  ): SshBranchAccessSummary {
    return SshBranchAccessSummarySchema.parse({
      branchId: branch.id,
      capsuleId: branch.capsuleId,
      branchName: branch.name,
      state: access.state,
      blockReason: access.blockReason,
      enabledAt: toNullableIsoTimestamp(access.enabledAt, 'enabledAt', branch.id),
      blockedAt: toNullableIsoTimestamp(access.blockedAt, 'blockedAt', branch.id),
      createdAt: toIsoTimestamp(access.createdAt, 'createdAt', branch.id),
      updatedAt: toIsoTimestamp(access.updatedAt, 'updatedAt', branch.id),
    })
  }
}
