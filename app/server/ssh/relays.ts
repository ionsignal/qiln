import { and, eq, inArray } from 'drizzle-orm'
import { SshRelayStatus, type SshRelayClosureReason } from '@qiln/core/server'
import { sshConflict, sshInternal } from './errors'
import { sshRelays, type sshBranchGrants, type sshPublicKeys, type sshTickets } from '@server/db/schema'
import type { Database } from '@server/db'

export type SshDatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface SshRelayCloser {
  closeRelayIds(relayIds: readonly string[]): Promise<readonly string[]>
}

export class UnavailableSshRelayCloser implements SshRelayCloser {
  public async closeRelayIds(relayIds: readonly string[]): Promise<readonly string[]> {
    if (relayIds.length === 0) {
      return []
    }
    throw sshConflict('Active SSH relays cannot be closed because the local gateway registry is unavailable.', {
      relayCount: relayIds.length,
    })
  }
}

export interface SshRevocationSelection {
  relayIds: string[]
  revokedGrantCount: number
  revokedTicketCount: number
}

type SshPublicKeyRow = typeof sshPublicKeys.$inferSelect
type SshBranchGrantRow = typeof sshBranchGrants.$inferSelect
type SshTicketRow = typeof sshTickets.$inferSelect

const REVOCABLE_RELAY_STATUSES = [SshRelayStatus.OPENING, SshRelayStatus.ACTIVE, SshRelayStatus.CLOSING] as const
const GATEWAY_STARTUP_RECOVERY_REASON = 'gateway_startup_recovery'

export class SshRelayCoordinator {
  private closer: SshRelayCloser = new UnavailableSshRelayCloser()

  constructor(
    private readonly db: Database,
    private readonly closureTimeoutMs: number,
  ) {
    if (!Number.isSafeInteger(closureTimeoutMs) || closureTimeoutMs <= 0) {
      throw new RangeError('SSH relay closure timeout must be a positive safe integer.')
    }
  }

  public setCloser(closer: SshRelayCloser): void {
    this.closer = closer
  }

  /**
   * Closes durable relays left opening, active, or closing by a prior process
   * using the same stable gateway instance identity.
   *
   * The local registry starts empty, so unknown relay IDs become tombstones
   * before the public gateway listener starts.
   */
  public async recoverGatewayRelays(gatewayInstanceId: string): Promise<number> {
    const relayIds = await this.db.transaction(async tx => {
      const selected = await tx
        .select({
          id: sshRelays.id,
          status: sshRelays.status,
        })
        .from(sshRelays)
        .where(
          and(eq(sshRelays.gatewayInstanceId, gatewayInstanceId), inArray(sshRelays.status, REVOCABLE_RELAY_STATUSES)),
        )
        .orderBy(sshRelays.id)
        .for('update')

      return await this.markSelectedRelaysClosing(tx, selected, GATEWAY_STARTUP_RECOVERY_REASON)
    })
    return await this.confirmRelayClosures(relayIds)
  }

  public async markBranchRelaysClosing(
    tx: SshDatabaseTransaction,
    branchIds: readonly string[],
    reason: SshRelayClosureReason,
  ): Promise<string[]> {
    if (branchIds.length === 0) {
      return []
    }
    const selected = await tx
      .select({
        id: sshRelays.id,
        status: sshRelays.status,
      })
      .from(sshRelays)
      .where(and(inArray(sshRelays.branchId, [...branchIds]), inArray(sshRelays.status, REVOCABLE_RELAY_STATUSES)))
      .orderBy(sshRelays.id)
      .for('update')
    return await this.markSelectedRelaysClosing(tx, selected, reason)
  }

  public async markPublicKeyRelaysClosing(
    tx: SshDatabaseTransaction,
    publicKeyId: string,
    reason: SshRelayClosureReason,
  ): Promise<string[]> {
    const selected = await tx
      .select({
        id: sshRelays.id,
        status: sshRelays.status,
      })
      .from(sshRelays)
      .where(and(eq(sshRelays.publicKeyId, publicKeyId), inArray(sshRelays.status, REVOCABLE_RELAY_STATUSES)))
      .orderBy(sshRelays.id)
      .for('update')
    return await this.markSelectedRelaysClosing(tx, selected, reason)
  }

  public async markGrantRelaysClosing(
    tx: SshDatabaseTransaction,
    grant: Pick<SshBranchGrantRow, 'publicKeyId' | 'branchId'>,
    reason: SshRelayClosureReason,
  ): Promise<string[]> {
    const selected = await tx
      .select({
        id: sshRelays.id,
        status: sshRelays.status,
      })
      .from(sshRelays)
      .where(
        and(
          eq(sshRelays.publicKeyId, grant.publicKeyId),
          eq(sshRelays.branchId, grant.branchId),
          inArray(sshRelays.status, REVOCABLE_RELAY_STATUSES),
        ),
      )
      .orderBy(sshRelays.id)
      .for('update')
    return await this.markSelectedRelaysClosing(tx, selected, reason)
  }

  /**
   * Confirms local closure and records durable closed state.
   *
   * A concurrent natural disconnect may already have transitioned a selected
   * relay from closing to closed. That is accepted after the row is locked and
   * proven closed.
   */
  public async confirmRelayClosures(relayIds: readonly string[]): Promise<number> {
    if (relayIds.length === 0) {
      return 0
    }
    const uniqueRelayIds = [...new Set(relayIds)]
    const confirmedIds = await this.withTimeout(this.closer.closeRelayIds(uniqueRelayIds))
    const uniqueConfirmedIds = [...new Set(confirmedIds)]
    if (
      uniqueConfirmedIds.length !== uniqueRelayIds.length ||
      uniqueRelayIds.some(relayId => !uniqueConfirmedIds.includes(relayId))
    ) {
      throw sshConflict('The local SSH gateway did not confirm closure of every selected relay.', {
        expectedRelayCount: uniqueRelayIds.length,
        confirmedRelayCount: uniqueConfirmedIds.length,
      })
    }
    return await this.db.transaction(async tx => {
      const selected = await tx
        .select({
          id: sshRelays.id,
          status: sshRelays.status,
        })
        .from(sshRelays)
        .where(inArray(sshRelays.id, uniqueRelayIds))
        .orderBy(sshRelays.id)
        .for('update')
      if (selected.length !== uniqueRelayIds.length) {
        throw sshConflict('One or more selected SSH relay records no longer exist.', {
          expectedRelayCount: uniqueRelayIds.length,
          actualRelayCount: selected.length,
        })
      }
      const invalid = selected.filter(
        relay => relay.status !== SshRelayStatus.CLOSING && relay.status !== SshRelayStatus.CLOSED,
      )
      if (invalid.length > 0) {
        throw sshConflict('One or more selected SSH relays are not durably closing or closed.', {
          relayIds: invalid.map(relay => relay.id),
          relayStatuses: invalid.map(relay => relay.status),
        })
      }
      const closingIds = selected.filter(relay => relay.status === SshRelayStatus.CLOSING).map(relay => relay.id)
      if (closingIds.length > 0) {
        const now = new Date()
        const closed = await tx
          .update(sshRelays)
          .set({
            status: SshRelayStatus.CLOSED,
            closedAt: now,
          })
          .where(and(inArray(sshRelays.id, closingIds), eq(sshRelays.status, SshRelayStatus.CLOSING)))
          .returning({
            id: sshRelays.id,
          })
        if (closed.length !== closingIds.length) {
          throw sshConflict('Durable SSH relay closure conflicted with another relay transition.', {
            expectedRelayCount: closingIds.length,
            closedRelayCount: closed.length,
          })
        }
      }
      return uniqueRelayIds.length
    })
  }

  public assertCanonicalKeyMatches(
    registeredKey: Pick<SshPublicKeyRow, 'algorithm' | 'publicKeyBlob' | 'fingerprint'>,
    offeredKey: {
      algorithm: string
      publicKeyBlob: string
      fingerprint: string
    },
  ): void {
    if (
      registeredKey.algorithm !== offeredKey.algorithm ||
      registeredKey.publicKeyBlob !== offeredKey.publicKeyBlob ||
      registeredKey.fingerprint !== offeredKey.fingerprint
    ) {
      throw sshConflict('The offered SSH public key does not match its registered canonical key identity.')
    }
  }

  public assertTicketBinding(
    ticket: Pick<SshTicketRow, 'publicKeyId' | 'grantId' | 'userId' | 'capsuleId' | 'branchId'>,
    grant: Pick<SshBranchGrantRow, 'id' | 'publicKeyId' | 'keyOwnerUserId' | 'capsuleId' | 'branchId'>,
  ): void {
    if (
      ticket.grantId !== grant.id ||
      ticket.publicKeyId !== grant.publicKeyId ||
      ticket.userId !== grant.keyOwnerUserId ||
      ticket.capsuleId !== grant.capsuleId ||
      ticket.branchId !== grant.branchId
    ) {
      throw sshConflict('The SSH ticket does not match its durable key and branch grant.')
    }
  }

  private async markSelectedRelaysClosing(
    tx: SshDatabaseTransaction,
    selected: ReadonlyArray<{
      id: string
      status: (typeof sshRelays.$inferSelect)['status']
    }>,
    reason: SshRelayClosureReason,
  ): Promise<string[]> {
    const transitionIds = selected
      .filter(relay => relay.status === SshRelayStatus.OPENING || relay.status === SshRelayStatus.ACTIVE)
      .map(relay => relay.id)
    if (transitionIds.length > 0) {
      const now = new Date()
      const transitioned = await tx
        .update(sshRelays)
        .set({
          status: SshRelayStatus.CLOSING,
          closingAt: now,
          closureReason: reason,
        })
        .where(
          and(
            inArray(sshRelays.id, transitionIds),
            inArray(sshRelays.status, [SshRelayStatus.OPENING, SshRelayStatus.ACTIVE]),
          ),
        )
        .returning({
          id: sshRelays.id,
        })
      if (transitioned.length !== transitionIds.length) {
        throw sshConflict('SSH relay revocation conflicted with another relay transition.', {
          expectedRelayCount: transitionIds.length,
          transitionedRelayCount: transitioned.length,
        })
      }
    }
    return selected.map(relay => relay.id)
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          sshInternal('Timed out while waiting for local SSH relay closure confirmation.', {
            timeoutMs: this.closureTimeoutMs,
          }),
        )
      }, this.closureTimeoutMs)
    })
    try {
      return await Promise.race([operation, timeout])
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle)
      }
    }
  }
}
