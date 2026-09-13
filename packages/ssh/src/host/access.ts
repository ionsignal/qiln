import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  SshBranchAccessState,
  SshBranchAccessSummarySchema,
  SshBranchGrantStatus,
  SshCapsuleAccessRevokeInputSchema,
  SshTicketStatus,
  type SshBranchAccessInitializationReason,
  type SshBranchAccessMutationOutput,
  type SshBranchAccessRevokeInput,
  type SshBranchAccessRevocationReason,
  type SshBranchAccessSummary,
  type SshCapsuleAccessRevokeInput,
  type SshCapsuleAccessRevocationOutput,
} from '@qiln/core/server'
import { sshConflict, sshNotFound, toIsoTimestamp, toNullableIsoTimestamp } from './errors'
import type { SshDatabaseTransaction, SshPersistence } from '../db/persistence'
import type { SshRelayCoordinator } from './relays'
import type { SshAuthorizedKeysSyncDispatcher } from './sync'

type AccessRow = SshPersistence['tables']['sshBranchAccess']['$inferSelect']
type BranchRow = SshPersistence['tables']['capsuleBranches']['$inferSelect']
type CapsuleRow = SshPersistence['tables']['capsules']['$inferSelect']

interface AccessRevocationTransactionResult {
  accesses: Array<{
    access: AccessRow
    branch: Pick<BranchRow, 'id' | 'capsuleId' | 'name'>
  }>
  changed: boolean
  revokedGrantCount: number
  revokedTicketCount: number
  relayIds: string[]
}

export class SshBranchAccessService {
  private readonly db: SshPersistence['db']
  private readonly tables: SshPersistence['tables']

  constructor(
    persistence: SshPersistence,
    private readonly relays: SshRelayCoordinator,
    private readonly authorizedKeysSync: SshAuthorizedKeysSyncDispatcher,
  ) {
    this.db = persistence.db
    this.tables = persistence.tables
  }

  public async initializeBlocked(
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
    reason: SshBranchAccessInitializationReason,
  ): Promise<SshBranchAccessMutationOutput> {
    const { sshBranchAccess } = this.tables
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
    const { sshBranchAccess } = this.tables
    return await this.db.transaction(async tx => {
      const capsule = await this.lockOwnedCapsule(tx, ownerUserId, capsuleId)
      const branch = await this.lockOwnedBranch(tx, ownerUserId, capsuleId, branchId)
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
    const transaction = await this.revokeAccess(ownerUserId, { capsuleId, branchId, reason })
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
    input: SshCapsuleAccessRevokeInput,
  ): Promise<SshCapsuleAccessRevocationOutput> {
    const request = SshCapsuleAccessRevokeInputSchema.parse(input)
    const transaction = await this.revokeAccess(ownerUserId, request)
    for (const record of transaction.accesses) {
      this.authorizedKeysSync.scheduleBranch(ownerUserId, record.branch.capsuleId, record.branch.id)
    }
    const closedRelayCount = await this.relays.confirmRelayClosures(transaction.relayIds)
    return {
      capsuleId: request.capsuleId,
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

  private async revokeAccess(
    ownerUserId: string,
    input: SshBranchAccessRevokeInput | SshCapsuleAccessRevokeInput,
  ): Promise<AccessRevocationTransactionResult> {
    const { capsuleId, reason } = input
    const { capsuleBranches, sshBranchAccess, sshBranchGrants, sshTickets } = this.tables
    return await this.db.transaction(async tx => {
      const capsule = await this.lockOwnedCapsule(tx, ownerUserId, capsuleId)
      const force =
        input.reason === 'capsule_destroy' ? await this.authorizeDestroy(tx, capsule, input.operationId) : false
      // Discover the complete lineage under the capsule lock rather than
      // revoking a branch list collected before operation authorization.
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
            eq(capsuleBranches.capsuleId, capsuleId),
            'branchId' in input ? eq(capsuleBranches.id, input.branchId) : undefined,
          ),
        )
        .orderBy(asc(capsuleBranches.id))
        .for('update')
      if (branches.length === 0) {
        throw sshNotFound('Capsule branches were not found for SSH access revocation.', {
          capsuleId,
        })
      }
      if (branches.some(branch => branch.ownerId !== ownerUserId)) {
        throw sshConflict('Capsule branch ownership is inconsistent during SSH access revocation.', {
          capsuleId,
        })
      }
      const branchIds = branches.map(branch => branch.id)
      const accessRows = await tx
        .select()
        .from(sshBranchAccess)
        .where(inArray(sshBranchAccess.branchId, branchIds))
        .orderBy(asc(sshBranchAccess.branchId))
        .for('update')
      const existingIds = new Set(accessRows.map(access => access.branchId))
      const missingIds = branchIds.filter(branchId => !existingIds.has(branchId))
      if (missingIds.length > 0 && !force) {
        throw sshConflict('One or more branch SSH access fences have not been initialized.', {
          capsuleId,
          expectedAccessCount: branchIds.length,
          actualAccessCount: accessRows.length,
        })
      }
      const now = new Date()
      if (missingIds.length > 0) {
        // Only persisted force policy may repair missing fences. The new rows
        // are blocked in the same transaction that revokes grants and tickets.
        const created = await tx
          .insert(sshBranchAccess)
          .values(
            missingIds.map(branchId => ({
              branchId,
              state: SshBranchAccessState.BLOCKED,
              blockReason: reason,
              enabledAt: null,
              blockedAt: now,
              createdAt: now,
              updatedAt: now,
            })),
          )
          .returning({
            branchId: sshBranchAccess.branchId,
          })
        if (created.length !== missingIds.length) {
          throw sshConflict('Failed to initialize every missing branch SSH access fence.', {
            capsuleId,
          })
        }
      }
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
      // A prior attempt may have committed blocking but failed to confirm
      // closure. Repeated revocation must still select outstanding relays.
      const revokedGrants = await tx
        .update(sshBranchGrants)
        .set({
          status: SshBranchGrantStatus.REVOKED,
          revokedByUserId: null,
          revokedAt: now,
        })
        .where(
          and(inArray(sshBranchGrants.branchId, branchIds), eq(sshBranchGrants.status, SshBranchGrantStatus.ACTIVE)),
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
            inArray(sshTickets.branchId, branchIds),
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
        .where(inArray(sshBranchAccess.branchId, branchIds))
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
          missingIds.length > 0 ||
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

  /**
   * The caller already holds the capsule lock. Force authorization comes from
   * the running operation's persisted audit fields, never a request flag. Host
   * administrator authorization remains the destroy acceptance boundary.
   */
  private async authorizeDestroy(
    tx: SshDatabaseTransaction,
    capsule: CapsuleRow,
    operationId: string,
  ): Promise<boolean> {
    const { capsuleOperations } = this.tables
    const [operation] = await tx
      .select()
      .from(capsuleOperations)
      .where(
        and(
          eq(capsuleOperations.id, operationId),
          eq(capsuleOperations.ownerId, capsule.ownerId),
          eq(capsuleOperations.capsuleId, capsule.id),
        ),
      )
      .for('update')
      .limit(1)
    if (
      !operation ||
      operation.type !== 'destroy' ||
      operation.status !== 'running' ||
      operation.executionStartedAt === null ||
      operation.completedAt !== null ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null ||
      capsule.lifecycleStatus !== 'destroying' ||
      capsule.destroyedAt !== null
    ) {
      throw sshConflict('Capsule SSH destruction revocation requires a running owned destroy operation.', {
        capsuleId: capsule.id,
        operationId,
      })
    }
    if (!operation.destroyForce) {
      if (operation.destroyForceReason !== null || operation.destroyForceAcknowledged) {
        throw sshConflict('Normal destroy contains inconsistent force audit evidence.', {
          capsuleId: capsule.id,
          operationId,
        })
      }
      return false
    }
    const reason = operation.destroyForceReason
    if (
      operation.actorType !== 'user' ||
      !operation.destroyForceAcknowledged ||
      reason === null ||
      reason.length < 1 ||
      reason.length > 2000 ||
      reason !== reason.trim()
    ) {
      throw sshConflict('Force destroy lacks valid user-authored audit evidence.', {
        capsuleId: capsule.id,
        operationId,
      })
    }
    return true
  }

  private async lockOwnedBranch(tx: SshDatabaseTransaction, ownerUserId: string, capsuleId: string, branchId: string) {
    const { capsuleBranches } = this.tables
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

  private async lockOwnedCapsule(tx: SshDatabaseTransaction, ownerUserId: string, capsuleId: string) {
    const { capsules } = this.tables
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

  private summary(access: AccessRow, branch: Pick<BranchRow, 'id' | 'capsuleId' | 'name'>): SshBranchAccessSummary {
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
