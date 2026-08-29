import { and, asc, eq } from 'drizzle-orm'
import {
  SshBranchGrantStatus,
  SshPublicKeyStatus,
  createSshAuthorizedKeysSyncRequest,
  type CapsuleNatsChannel,
} from '@qiln/core/server'
import { sshBranchGrants, sshPublicKeys } from '@server/db/schema'
import type { Database } from '@server/db'
import type { FastifyBaseLogger } from 'fastify'

/**
 * Non-authoritative Host-to-Worker branch authorized-key dispatcher.
 *
 * This service derives the current canonical key set only from active Host
 * grants joined to active registered keys. Delivery is intentionally detached:
 * Worker synchronization affects branch-local SSH availability only and never
 * changes Host grant, fence, ticket, or relay authority.
 */
export class SshAuthorizedKeysSyncDispatcher {
  constructor(
    private readonly db: Database,
    private readonly channel: CapsuleNatsChannel,
    private readonly logger: FastifyBaseLogger,
  ) {}

  /**
   * Schedules one best-effort branch key-file synchronization after its source
   * Host transaction has committed.
   *
   * The call intentionally cannot affect the mutation that triggered it. A
   * failed Worker delivery is logged without including canonical key material,
   * payload bytes, or digests.
   */
  public scheduleBranch(ownerId: string, capsuleId: string, branchId: string): void {
    void this.dispatchBranch(ownerId, capsuleId, branchId).catch((error: unknown) => {
      this.logger.warn(
        {
          ownerId,
          capsuleId,
          branchId,
          failureKind: this.failureKind(error),
        },
        '[SSH] Best-effort branch authorized-key synchronization delivery failed.',
      )
    })
  }

  private async dispatchBranch(ownerId: string, capsuleId: string, branchId: string): Promise<void> {
    const keys = await this.db
      .select({
        algorithm: sshPublicKeys.algorithm,
        publicKeyBlob: sshPublicKeys.publicKeyBlob,
      })
      .from(sshBranchGrants)
      .innerJoin(sshPublicKeys, eq(sshPublicKeys.id, sshBranchGrants.publicKeyId))
      .where(
        and(
          eq(sshBranchGrants.capsuleId, capsuleId),
          eq(sshBranchGrants.branchId, branchId),
          eq(sshBranchGrants.status, SshBranchGrantStatus.ACTIVE),
          eq(sshPublicKeys.status, SshPublicKeyStatus.ACTIVE),
        ),
      )
      .orderBy(asc(sshPublicKeys.algorithm), asc(sshPublicKeys.publicKeyBlob))
    const request = createSshAuthorizedKeysSyncRequest({
      ownerId,
      capsuleId,
      branchId,
      keyLines: keys.map(key => `${key.algorithm} ${key.publicKeyBlob}`),
    })
    await this.channel.syncSshAuthorizedKeys(request)
  }

  private failureKind(error: unknown): string {
    return error instanceof Error && error.name !== '' ? error.name : 'UnknownError'
  }
}
