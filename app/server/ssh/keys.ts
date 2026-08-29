import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  SshBranchGrantStatus,
  SshPublicKeyStatus,
  SshPublicKeySummarySchema,
  SshTicketStatus,
  type SshPublicKeyRegistration,
  type SshPublicKeySummary,
} from '@qiln/core/server'
import { parseOpenSshPublicKey, SshPublicKeyError } from '@qiln/ssh/server'
import { sshBranchGrants, sshPublicKeys, sshTickets } from '@server/db/schema'
import { sshBadRequest, sshConflict, sshNotFound, toIsoTimestamp, toNullableIsoTimestamp } from './errors'
import type { Database } from '@server/db'
import type { SshRelayCoordinator } from './relays'
import type { SshAuthorizedKeysSyncDispatcher } from './sync'

const KEY_REVOCATION_RELAY_REASON = 'public_key_revoked'

interface SshAuthorizedKeysSyncTarget {
  ownerUserId: string
  capsuleId: string
  branchId: string
}

interface SshPublicKeyRevocation {
  key: typeof sshPublicKeys.$inferSelect
  relayIds: string[]
  branchSyncTargets: SshAuthorizedKeysSyncTarget[]
}

export class SshPublicKeyService {
  constructor(
    private readonly db: Database,
    private readonly relays: SshRelayCoordinator,
    private readonly authorizedKeysSync: SshAuthorizedKeysSyncDispatcher,
  ) {}

  public async register(ownerUserId: string, input: SshPublicKeyRegistration): Promise<SshPublicKeySummary> {
    let canonicalKey
    try {
      canonicalKey = parseOpenSshPublicKey(input.publicKey)
    } catch (error: unknown) {
      if (error instanceof SshPublicKeyError) {
        throw sshBadRequest(error.message, {
          keyErrorCode: error.code,
        })
      }
      throw error
    }
    try {
      const [created] = await this.db
        .insert(sshPublicKeys)
        .values({
          ownerUserId,
          algorithm: canonicalKey.algorithm,
          publicKeyBlob: canonicalKey.publicKeyBlob,
          fingerprint: canonicalKey.fingerprint,
          label: input.label ?? null,
          status: SshPublicKeyStatus.ACTIVE,
        })
        .returning()
      if (!created) {
        throw sshConflict('Failed to register the SSH public key.')
      }
      return this.summary(created)
    } catch (error: unknown) {
      const existing = await this.db
        .select()
        .from(sshPublicKeys)
        .where(eq(sshPublicKeys.publicKeyBlob, canonicalKey.publicKeyBlob))
        .limit(1)

      const key = existing[0]
      if (key) {
        throw sshConflict('This SSH public key is already registered.', {
          registeredOwnerUserId: key.ownerUserId,
          publicKeyId: key.id,
        })
      }
      throw error
    }
  }

  public async list(ownerUserId: string): Promise<SshPublicKeySummary[]> {
    const keys = await this.db
      .select()
      .from(sshPublicKeys)
      .where(eq(sshPublicKeys.ownerUserId, ownerUserId))
      .orderBy(asc(sshPublicKeys.createdAt), asc(sshPublicKeys.id))
    return keys.map(key => this.summary(key))
  }

  public async revoke(ownerUserId: string, publicKeyId: string): Promise<SshPublicKeySummary> {
    const revocation: SshPublicKeyRevocation = await this.db.transaction(async tx => {
      const [key] = await tx
        .select()
        .from(sshPublicKeys)
        .where(and(eq(sshPublicKeys.id, publicKeyId), eq(sshPublicKeys.ownerUserId, ownerUserId)))
        .for('update')
        .limit(1)
      if (!key) {
        throw sshNotFound('SSH public key not found.')
      }
      if (key.status === SshPublicKeyStatus.REVOKED) {
        return {
          key,
          relayIds: [] as string[],
          branchSyncTargets: [] as SshAuthorizedKeysSyncTarget[],
        }
      }
      const activeGrants = await tx
        .select({
          capsuleOwnerUserId: sshBranchGrants.capsuleOwnerUserId,
          capsuleId: sshBranchGrants.capsuleId,
          branchId: sshBranchGrants.branchId,
        })
        .from(sshBranchGrants)
        .where(and(eq(sshBranchGrants.publicKeyId, key.id), eq(sshBranchGrants.status, SshBranchGrantStatus.ACTIVE)))
        .orderBy(asc(sshBranchGrants.capsuleOwnerUserId), asc(sshBranchGrants.capsuleId), asc(sshBranchGrants.branchId))
        .for('update')
      const now = new Date()
      const [revokedKey] = await tx
        .update(sshPublicKeys)
        .set({
          status: SshPublicKeyStatus.REVOKED,
          revokedAt: now,
        })
        .where(and(eq(sshPublicKeys.id, key.id), eq(sshPublicKeys.status, SshPublicKeyStatus.ACTIVE)))
        .returning()

      if (!revokedKey) {
        throw sshConflict('SSH public-key revocation conflicted with another state transition.')
      }
      await tx
        .update(sshBranchGrants)
        .set({
          status: SshBranchGrantStatus.REVOKED,
          revokedByUserId: ownerUserId,
          revokedAt: now,
        })
        .where(and(eq(sshBranchGrants.publicKeyId, key.id), eq(sshBranchGrants.status, SshBranchGrantStatus.ACTIVE)))
      await tx
        .update(sshTickets)
        .set({
          status: SshTicketStatus.REVOKED,
          revokedAt: now,
        })
        .where(
          and(
            eq(sshTickets.publicKeyId, key.id),
            inArray(sshTickets.status, [SshTicketStatus.ISSUED, SshTicketStatus.REDEEMED]),
          ),
        )
      const relayIds = await this.relays.markPublicKeyRelaysClosing(tx, key.id, KEY_REVOCATION_RELAY_REASON)
      const branchSyncTargets = new Map<string, SshAuthorizedKeysSyncTarget>()
      for (const grant of activeGrants) {
        const target = {
          ownerUserId: grant.capsuleOwnerUserId,
          capsuleId: grant.capsuleId,
          branchId: grant.branchId,
        }

        branchSyncTargets.set(`${target.ownerUserId}:${target.capsuleId}:${target.branchId}`, target)
      }
      return {
        key: revokedKey,
        relayIds,
        branchSyncTargets: Array.from(branchSyncTargets.values()),
      }
    })
    for (const target of revocation.branchSyncTargets) {
      this.authorizedKeysSync.scheduleBranch(target.ownerUserId, target.capsuleId, target.branchId)
    }
    await this.relays.confirmRelayClosures(revocation.relayIds)
    return this.summary(revocation.key)
  }

  private summary(key: typeof sshPublicKeys.$inferSelect): SshPublicKeySummary {
    return SshPublicKeySummarySchema.parse({
      id: key.id,
      ownerUserId: key.ownerUserId,
      algorithm: key.algorithm,
      fingerprint: key.fingerprint,
      label: key.label,
      status: key.status,
      createdAt: toIsoTimestamp(key.createdAt, 'createdAt', key.id),
      revokedAt: toNullableIsoTimestamp(key.revokedAt, 'revokedAt', key.id),
    })
  }
}
