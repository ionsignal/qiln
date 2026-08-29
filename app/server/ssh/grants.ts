import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  SshBranchAccessState,
  SshBranchGrantStatus,
  SshBranchGrantSummarySchema,
  SshOpenSshConfigOutputSchema,
  SshPublicKeyStatus,
  SshTicketStatus,
  type SshBranchGrantSummary,
  type SshOpenSshConfigOutput,
} from '@qiln/core/server'
import {
  capsules,
  capsuleBranches,
  sshBranchAccess,
  sshBranchGrants,
  sshPublicKeys,
  sshTickets,
  users,
} from '@server/db/schema'
import { sshConflict, sshForbidden, sshNotFound, toIsoTimestamp, toNullableIsoTimestamp } from './errors'
import type { Database } from '@server/db'
import type { SshConfig } from '@/types/config'
import type { SshRelayCoordinator } from './relays'
import type { SshAuthorizedKeysSyncDispatcher } from './sync'

const GRANT_REVOCATION_RELAY_REASON = 'branch_grant_revoked'
const SSH_CONFIG_TOKEN_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/

interface SshAuthorizedKeysSyncTarget {
  ownerUserId: string
  capsuleId: string
  branchId: string
}

export class SshBranchGrantService {
  constructor(
    private readonly db: Database,
    private readonly relays: SshRelayCoordinator,
    private readonly config: SshConfig,
    private readonly authorizedKeysSync: SshAuthorizedKeysSyncDispatcher,
  ) {}

  public async bind(adminUserId: string, publicKeyId: string, branchId: string): Promise<SshBranchGrantSummary> {
    const summary = await this.db.transaction(async tx => {
      const [admin] = await tx
        .select({
          id: users.id,
          isAdmin: users.isAdmin,
        })
        .from(users)
        .where(eq(users.id, adminUserId))
        .for('update')
        .limit(1)
      if (!admin?.isAdmin) {
        throw sshForbidden('Administrator access is required to bind an SSH key.')
      }
      const [key] = await tx
        .select()
        .from(sshPublicKeys)
        .where(eq(sshPublicKeys.id, publicKeyId))
        .for('update')
        .limit(1)
      if (!key || key.status !== SshPublicKeyStatus.ACTIVE) {
        throw sshNotFound('An active SSH public key was not found.')
      }
      const [branch] = await tx
        .select({
          id: capsuleBranches.id,
          capsuleId: capsuleBranches.capsuleId,
          ownerId: capsuleBranches.ownerId,
          name: capsuleBranches.name,
          status: capsuleBranches.status,
        })
        .from(capsuleBranches)
        .where(eq(capsuleBranches.id, branchId))
        .for('update')
        .limit(1)

      if (!branch) {
        throw sshNotFound('Capsule branch not found.')
      }
      const [capsule] = await tx
        .select({
          id: capsules.id,
          ownerId: capsules.ownerId,
          lifecycleStatus: capsules.lifecycleStatus,
          archivedAt: capsules.archivedAt,
        })
        .from(capsules)
        .where(eq(capsules.id, branch.capsuleId))
        .for('update')
        .limit(1)
      const [access] = await tx
        .select()
        .from(sshBranchAccess)
        .where(eq(sshBranchAccess.branchId, branch.id))
        .for('update')
        .limit(1)
      if (
        !capsule ||
        capsule.ownerId !== branch.ownerId ||
        capsule.lifecycleStatus !== 'active' ||
        capsule.archivedAt !== null ||
        branch.status !== 'online' ||
        access?.state !== SshBranchAccessState.ENABLED
      ) {
        throw sshConflict('SSH keys may be bound only to an enabled, online editable capsule branch.', {
          branchId: branch.id,
          branchStatus: branch.status,
          accessState: access?.state ?? null,
          capsuleLifecycleStatus: capsule?.lifecycleStatus ?? null,
          capsuleArchived: capsule ? capsule.archivedAt !== null : null,
        })
      }
      const [existingActiveGrant] = await tx
        .select({
          id: sshBranchGrants.id,
          branchId: sshBranchGrants.branchId,
        })
        .from(sshBranchGrants)
        .where(and(eq(sshBranchGrants.publicKeyId, key.id), eq(sshBranchGrants.status, SshBranchGrantStatus.ACTIVE)))
        .for('update')
        .limit(1)
      if (existingActiveGrant) {
        throw sshConflict('This SSH key already has an active editable-branch grant.', {
          grantId: existingActiveGrant.id,
          branchId: existingActiveGrant.branchId,
        })
      }
      const [grant] = await tx
        .insert(sshBranchGrants)
        .values({
          publicKeyId: key.id,
          keyOwnerUserId: key.ownerUserId,
          capsuleOwnerUserId: capsule.ownerId,
          capsuleId: capsule.id,
          branchId: branch.id,
          boundByAdminUserId: admin.id,
          revokedByUserId: null,
          status: SshBranchGrantStatus.ACTIVE,
        })
        .returning()
      if (!grant) {
        throw sshConflict('Failed to create the SSH branch grant.')
      }
      return this.summary(grant, key, branch.name)
    })
    this.authorizedKeysSync.scheduleBranch(summary.capsuleOwnerUserId, summary.capsuleId, summary.branchId)
    return summary
  }

  public async revoke(adminUserId: string, grantId: string): Promise<SshBranchGrantSummary> {
    const revocation = await this.db.transaction(async tx => {
      const [admin] = await tx
        .select({
          id: users.id,
          isAdmin: users.isAdmin,
        })
        .from(users)
        .where(eq(users.id, adminUserId))
        .for('update')
        .limit(1)
      if (!admin?.isAdmin) {
        throw sshForbidden('Administrator access is required to revoke an SSH branch grant.')
      }
      const [grant] = await tx
        .select()
        .from(sshBranchGrants)
        .where(eq(sshBranchGrants.id, grantId))
        .for('update')
        .limit(1)

      if (!grant) {
        throw sshNotFound('SSH branch grant not found.')
      }
      const [key] = await tx
        .select()
        .from(sshPublicKeys)
        .where(eq(sshPublicKeys.id, grant.publicKeyId))
        .for('update')
        .limit(1)
      const [branch] = await tx
        .select({
          name: capsuleBranches.name,
        })
        .from(capsuleBranches)
        .where(eq(capsuleBranches.id, grant.branchId))
        .for('update')
        .limit(1)
      if (!key || !branch) {
        throw sshConflict('The SSH branch grant has incomplete durable identity.')
      }
      if (grant.status === SshBranchGrantStatus.REVOKED) {
        return {
          grant,
          key,
          branchName: branch.name,
          relayIds: [] as string[],
          authorizedKeysSyncTarget: null as SshAuthorizedKeysSyncTarget | null,
        }
      }
      const now = new Date()
      const [revokedGrant] = await tx
        .update(sshBranchGrants)
        .set({
          status: SshBranchGrantStatus.REVOKED,
          revokedByUserId: admin.id,
          revokedAt: now,
        })
        .where(and(eq(sshBranchGrants.id, grant.id), eq(sshBranchGrants.status, SshBranchGrantStatus.ACTIVE)))
        .returning()
      if (!revokedGrant) {
        throw sshConflict('SSH branch-grant revocation conflicted with another state transition.')
      }
      await tx
        .update(sshTickets)
        .set({
          status: SshTicketStatus.REVOKED,
          revokedAt: now,
        })
        .where(
          and(
            eq(sshTickets.grantId, grant.id),
            inArray(sshTickets.status, [SshTicketStatus.ISSUED, SshTicketStatus.REDEEMED]),
          ),
        )
      const relayIds = await this.relays.markGrantRelaysClosing(tx, revokedGrant, GRANT_REVOCATION_RELAY_REASON)
      return {
        grant: revokedGrant,
        key,
        branchName: branch.name,
        relayIds,
        authorizedKeysSyncTarget: {
          ownerUserId: revokedGrant.capsuleOwnerUserId,
          capsuleId: revokedGrant.capsuleId,
          branchId: revokedGrant.branchId,
        } satisfies SshAuthorizedKeysSyncTarget,
      }
    })
    if (revocation.authorizedKeysSyncTarget !== null) {
      this.authorizedKeysSync.scheduleBranch(
        revocation.authorizedKeysSyncTarget.ownerUserId,
        revocation.authorizedKeysSyncTarget.capsuleId,
        revocation.authorizedKeysSyncTarget.branchId,
      )
    }
    await this.relays.confirmRelayClosures(revocation.relayIds)
    return this.summary(revocation.grant, revocation.key, revocation.branchName)
  }

  public async listAll(adminUserId: string): Promise<SshBranchGrantSummary[]> {
    const [admin] = await this.db
      .select({
        isAdmin: users.isAdmin,
      })
      .from(users)
      .where(eq(users.id, adminUserId))
      .limit(1)
    if (!admin?.isAdmin) {
      throw sshForbidden('Administrator access is required to list SSH branch grants.')
    }
    const grants = await this.db
      .select({
        grant: sshBranchGrants,
        key: sshPublicKeys,
        branchName: capsuleBranches.name,
      })
      .from(sshBranchGrants)
      .innerJoin(sshPublicKeys, eq(sshPublicKeys.id, sshBranchGrants.publicKeyId))
      .innerJoin(capsuleBranches, eq(capsuleBranches.id, sshBranchGrants.branchId))
      .orderBy(asc(sshBranchGrants.createdAt), asc(sshBranchGrants.id))
    return grants.map(record => this.summary(record.grant, record.key, record.branchName))
  }

  public async generateOpenSshConfig(userId: string, publicKeyId: string): Promise<SshOpenSshConfigOutput> {
    const records = await this.db
      .select({
        grantId: sshBranchGrants.id,
        branchId: sshBranchGrants.branchId,
        branchName: capsuleBranches.name,
        keyOwnerUserId: sshBranchGrants.keyOwnerUserId,
        keyStatus: sshPublicKeys.status,
        grantStatus: sshBranchGrants.status,
        accessState: sshBranchAccess.state,
        branchStatus: capsuleBranches.status,
        capsuleLifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
      })
      .from(sshBranchGrants)
      .innerJoin(sshPublicKeys, eq(sshPublicKeys.id, sshBranchGrants.publicKeyId))
      .innerJoin(capsuleBranches, eq(capsuleBranches.id, sshBranchGrants.branchId))
      .innerJoin(capsules, eq(capsules.id, sshBranchGrants.capsuleId))
      .innerJoin(sshBranchAccess, eq(sshBranchAccess.branchId, sshBranchGrants.branchId))
      .where(
        and(
          eq(sshBranchGrants.publicKeyId, publicKeyId),
          eq(sshBranchGrants.keyOwnerUserId, userId),
          eq(sshBranchGrants.status, SshBranchGrantStatus.ACTIVE),
        ),
      )
      .limit(2)
    if (records.length !== 1) {
      throw sshNotFound('An active SSH branch grant was not found for this public key.')
    }
    const record = records[0]!
    if (
      record.keyStatus !== SshPublicKeyStatus.ACTIVE ||
      record.grantStatus !== SshBranchGrantStatus.ACTIVE ||
      record.accessState !== SshBranchAccessState.ENABLED ||
      record.branchStatus !== 'online' ||
      record.capsuleLifecycleStatus !== 'active' ||
      record.archivedAt !== null
    ) {
      throw sshConflict('The SSH branch grant is not currently eligible for an OpenSSH configuration.')
    }
    const gatewayHostAlias = this.assertConfigToken(this.config.gatewayHostAlias, 'gateway host alias')
    const publicHost = this.assertConfigToken(this.config.publicHost, 'public SSH host')
    const defaultIdentityFile = this.assertConfigToken(this.config.defaultIdentityFile, 'default identity file')
    const branchHostAlias = this.branchAlias(record.branchName, record.branchId)
    const config = [
      `Host ${gatewayHostAlias}`,
      `  HostName ${publicHost}`,
      `  Port ${this.config.publicPort}`,
      '  User qiln-gateway',
      `  IdentityFile ${defaultIdentityFile}`,
      '  IdentitiesOnly yes',
      '  RequestTTY no',
      '  ControlMaster no',
      '  LogLevel ERROR',
      '',
      `Host ${branchHostAlias}`,
      `  HostName ${branchHostAlias}`,
      `  HostKeyAlias ${branchHostAlias}`,
      '  User qiln',
      `  IdentityFile ${defaultIdentityFile}`,
      '  IdentitiesOnly yes',
      '  ForwardAgent no',
      `  ProxyCommand ssh -T -o RequestTTY=no -o LogLevel=ERROR ${gatewayHostAlias}`,
      '',
    ].join('\n')
    return SshOpenSshConfigOutputSchema.parse({
      gatewayHostAlias,
      branchHostAlias,
      branchName: record.branchName,
      config,
    })
  }

  private summary(
    grant: typeof sshBranchGrants.$inferSelect,
    key: typeof sshPublicKeys.$inferSelect,
    branchName: string,
  ): SshBranchGrantSummary {
    return SshBranchGrantSummarySchema.parse({
      id: grant.id,
      publicKeyId: grant.publicKeyId,
      keyOwnerUserId: grant.keyOwnerUserId,
      capsuleOwnerUserId: grant.capsuleOwnerUserId,
      capsuleId: grant.capsuleId,
      branchId: grant.branchId,
      branchName,
      boundByAdminUserId: grant.boundByAdminUserId,
      revokedByUserId: grant.revokedByUserId,
      keyAlgorithm: key.algorithm,
      keyFingerprint: key.fingerprint,
      keyLabel: key.label,
      status: grant.status,
      createdAt: toIsoTimestamp(grant.createdAt, 'createdAt', grant.id),
      revokedAt: toNullableIsoTimestamp(grant.revokedAt, 'revokedAt', grant.id),
    })
  }

  private branchAlias(branchName: string, branchId: string): string {
    const normalizedName = branchName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    const safeName = normalizedName || 'branch'
    return this.assertConfigToken(
      `${this.config.branchHostAliasPrefix}-${safeName}-${branchId.slice(0, 8)}`,
      'branch host alias',
    )
  }

  private assertConfigToken(value: string, field: string): string {
    if (!SSH_CONFIG_TOKEN_PATTERN.test(value)) {
      throw sshConflict(`Configured SSH ${field} cannot be rendered safely in an OpenSSH configuration.`)
    }
    return value
  }
}
