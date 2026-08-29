import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { and, eq, isNull } from 'drizzle-orm'
import {
  SshBranchAccessState,
  SshBranchDestinationSchema,
  SshBranchGrantStatus,
  SshGatewayKeyEligibilityOutputSchema,
  SshGatewayInstanceIdSchema,
  SshOpaqueTicketSchema,
  SshPublicKeyStatus,
  SshRelayActivationOutputSchema,
  SshRelayCloseOutputSchema,
  SshRelayOpeningSchema,
  SshRelayClosureReasonSchema,
  SshRelayStatus,
  SshTicketIssueOutputSchema,
  SshTicketStatus,
  type SshCanonicalPublicKey,
  type SshGatewayKeyEligibilityOutput,
  type SshRelayActivationOutput,
  type SshRelayCloseOutput,
  type SshRelayOpening,
  type SshTicketIssueOutput,
} from '@qiln/core/server'
import {
  capsules,
  capsuleBranches,
  sshBranchAccess,
  sshBranchGrants,
  sshPublicKeys,
  sshRelays,
  sshTickets,
} from '@server/db/schema'
import { sshConflict, sshForbidden, sshNotFound, toIsoTimestamp } from './errors'
import type { Database } from '@server/db'
import type { SshRelayCoordinator } from './relays'

interface SshAuthorizedBinding {
  userId: string
  capsuleId: string
  branchId: string
  registeredKey: typeof sshPublicKeys.$inferSelect
  grant: typeof sshBranchGrants.$inferSelect
}

export class SshTicketService {
  constructor(
    private readonly db: Database,
    private readonly relays: SshRelayCoordinator,
    private readonly ticketTtlMs: number,
  ) {
    if (!Number.isSafeInteger(ticketTtlMs) || ticketTtlMs <= 0) {
      throw new RangeError('SSH ticket TTL must be a positive safe integer.')
    }
  }

  public async checkEligibility(key: SshCanonicalPublicKey): Promise<SshGatewayKeyEligibilityOutput> {
    const eligible = await this.db
      .select({
        keyId: sshPublicKeys.id,
      })
      .from(sshPublicKeys)
      .innerJoin(
        sshBranchGrants,
        and(
          eq(sshBranchGrants.publicKeyId, sshPublicKeys.id),
          eq(sshBranchGrants.keyOwnerUserId, sshPublicKeys.ownerUserId),
          eq(sshBranchGrants.status, SshBranchGrantStatus.ACTIVE),
        ),
      )
      .innerJoin(
        sshBranchAccess,
        and(
          eq(sshBranchAccess.branchId, sshBranchGrants.branchId),
          eq(sshBranchAccess.state, SshBranchAccessState.ENABLED),
        ),
      )
      .innerJoin(
        capsuleBranches,
        and(
          eq(capsuleBranches.id, sshBranchGrants.branchId),
          eq(capsuleBranches.capsuleId, sshBranchGrants.capsuleId),
          eq(capsuleBranches.ownerId, sshBranchGrants.capsuleOwnerUserId),
          eq(capsuleBranches.status, 'online'),
        ),
      )
      .innerJoin(
        capsules,
        and(
          eq(capsules.id, sshBranchGrants.capsuleId),
          eq(capsules.ownerId, sshBranchGrants.capsuleOwnerUserId),
          eq(capsules.lifecycleStatus, 'active'),
          isNull(capsules.archivedAt),
        ),
      )
      .where(
        and(
          eq(sshPublicKeys.algorithm, key.algorithm),
          eq(sshPublicKeys.publicKeyBlob, key.publicKeyBlob),
          eq(sshPublicKeys.fingerprint, key.fingerprint),
          eq(sshPublicKeys.status, SshPublicKeyStatus.ACTIVE),
        ),
      )
      .limit(1)

    return SshGatewayKeyEligibilityOutputSchema.parse({
      eligible: eligible.length === 1,
    })
  }

  public async issue(key: SshCanonicalPublicKey): Promise<SshTicketIssueOutput> {
    const opaqueTicket = SshOpaqueTicketSchema.parse(randomBytes(32).toString('base64url'))
    const ticketHash = this.hashTicket(opaqueTicket)
    const result = await this.db.transaction(async tx => {
      const eligibleBinding = await this.lockEligibleBinding(tx, key)
      const issuedAt = new Date()
      const expiresAt = new Date(issuedAt.getTime() + this.ticketTtlMs)
      const [ticket] = await tx
        .insert(sshTickets)
        .values({
          ticketHash,
          publicKeyId: eligibleBinding.key.id,
          grantId: eligibleBinding.grant.id,
          userId: eligibleBinding.key.ownerUserId,
          capsuleId: eligibleBinding.branch.capsuleId,
          branchId: eligibleBinding.branch.id,
          status: SshTicketStatus.ISSUED,
          expiresAt,
          issuedAt,
        })
        .returning({
          id: sshTickets.id,
          expiresAt: sshTickets.expiresAt,
        })
      if (!ticket) {
        throw sshConflict('Failed to issue the SSH gateway ticket.')
      }
      return ticket
    })
    return SshTicketIssueOutputSchema.parse({
      ticket: opaqueTicket,
      expiresAt: toIsoTimestamp(result.expiresAt, 'expiresAt', result.id),
    })
  }

  public async redeem(
    opaqueTicket: string,
    key: SshCanonicalPublicKey,
    gatewayInstanceId: string,
  ): Promise<SshRelayOpening> {
    const ticketHash = this.hashTicket(SshOpaqueTicketSchema.parse(opaqueTicket))
    const parsedGatewayInstanceId = SshGatewayInstanceIdSchema.parse(gatewayInstanceId)
    return await this.db.transaction(async tx => {
      const [ticket] = await tx
        .select()
        .from(sshTickets)
        .where(eq(sshTickets.ticketHash, ticketHash))
        .for('update')
        .limit(1)
      if (!ticket) {
        throw sshNotFound('SSH gateway ticket not found.')
      }
      if (ticket.status !== SshTicketStatus.ISSUED || ticket.expiresAt.getTime() <= Date.now()) {
        throw sshForbidden('SSH gateway ticket is expired, revoked, redeemed, or otherwise ineligible.')
      }
      const [registeredKey] = await tx
        .select()
        .from(sshPublicKeys)
        .where(eq(sshPublicKeys.id, ticket.publicKeyId))
        .for('update')
        .limit(1)
      const [grant] = await tx
        .select()
        .from(sshBranchGrants)
        .where(eq(sshBranchGrants.id, ticket.grantId))
        .for('update')
        .limit(1)
      if (!registeredKey || !grant) {
        throw sshConflict('SSH gateway ticket has incomplete durable key or grant identity.')
      }
      this.relays.assertCanonicalKeyMatches(registeredKey, key)
      this.relays.assertTicketBinding(ticket, grant)
      const destination = await this.lockAndValidateDestination(tx, {
        userId: ticket.userId,
        capsuleId: ticket.capsuleId,
        branchId: ticket.branchId,
        registeredKey,
        grant,
      })
      const now = new Date()
      const [redeemed] = await tx
        .update(sshTickets)
        .set({
          status: SshTicketStatus.REDEEMED,
          redeemedAt: now,
        })
        .where(and(eq(sshTickets.id, ticket.id), eq(sshTickets.status, SshTicketStatus.ISSUED)))
        .returning({
          id: sshTickets.id,
        })
      if (!redeemed) {
        throw sshConflict('SSH gateway ticket redemption conflicted with another request.')
      }
      const [relay] = await tx
        .insert(sshRelays)
        .values({
          ticketId: ticket.id,
          publicKeyId: ticket.publicKeyId,
          userId: ticket.userId,
          capsuleId: ticket.capsuleId,
          branchId: ticket.branchId,
          gatewayInstanceId: parsedGatewayInstanceId,
          status: SshRelayStatus.OPENING,
          openedAt: now,
        })
        .returning({
          id: sshRelays.id,
          openedAt: sshRelays.openedAt,
        })
      if (!relay) {
        throw sshConflict('Failed to create the opening SSH relay record.')
      }
      return SshRelayOpeningSchema.parse({
        relayId: relay.id,
        destination,
        openedAt: toIsoTimestamp(relay.openedAt, 'openedAt', relay.id),
      })
    })
  }

  public async activate(relayId: string, gatewayInstanceId: string): Promise<SshRelayActivationOutput> {
    const parsedGatewayInstanceId = SshGatewayInstanceIdSchema.parse(gatewayInstanceId)
    return await this.db.transaction(async tx => {
      const [relay] = await tx
        .select()
        .from(sshRelays)
        .where(and(eq(sshRelays.id, relayId), eq(sshRelays.gatewayInstanceId, parsedGatewayInstanceId)))
        .for('update')
        .limit(1)
      if (!relay || relay.status !== SshRelayStatus.OPENING) {
        throw sshConflict('SSH relay is not eligible for activation.', {
          relayId,
        })
      }
      const [ticket] = await tx
        .select()
        .from(sshTickets)
        .where(eq(sshTickets.id, relay.ticketId))
        .for('update')
        .limit(1)
      const [key] = await tx
        .select()
        .from(sshPublicKeys)
        .where(eq(sshPublicKeys.id, relay.publicKeyId))
        .for('update')
        .limit(1)
      const [grant] = ticket
        ? await tx.select().from(sshBranchGrants).where(eq(sshBranchGrants.id, ticket.grantId)).for('update').limit(1)
        : []
      if (
        !ticket ||
        !key ||
        !grant ||
        ticket.status !== SshTicketStatus.REDEEMED ||
        relay.publicKeyId !== ticket.publicKeyId ||
        relay.userId !== ticket.userId ||
        relay.capsuleId !== ticket.capsuleId ||
        relay.branchId !== ticket.branchId
      ) {
        throw sshConflict('SSH relay activation has inconsistent durable ticket identity.', {
          relayId,
        })
      }
      this.relays.assertTicketBinding(ticket, grant)
      const destination = await this.lockAndValidateDestination(tx, {
        userId: relay.userId,
        capsuleId: relay.capsuleId,
        branchId: relay.branchId,
        registeredKey: key,
        grant,
      })
      const now = new Date()
      const [activated] = await tx
        .update(sshRelays)
        .set({
          status: SshRelayStatus.ACTIVE,
          activatedAt: now,
        })
        .where(and(eq(sshRelays.id, relay.id), eq(sshRelays.status, SshRelayStatus.OPENING)))
        .returning({
          id: sshRelays.id,
          activatedAt: sshRelays.activatedAt,
        })
      if (!activated?.activatedAt) {
        throw sshConflict('SSH relay activation conflicted with access revocation.', {
          relayId,
        })
      }
      return SshRelayActivationOutputSchema.parse({
        relayId: relay.id,
        destination,
        activatedAt: toIsoTimestamp(activated.activatedAt, 'activatedAt', relay.id),
      })
    })
  }

  public async close(relayId: string, gatewayInstanceId: string, reason: string): Promise<SshRelayCloseOutput> {
    const parsedGatewayInstanceId = SshGatewayInstanceIdSchema.parse(gatewayInstanceId)
    const parsedReason = SshRelayClosureReasonSchema.parse(reason)
    return await this.db.transaction(async tx => {
      const [relay] = await tx
        .select()
        .from(sshRelays)
        .where(and(eq(sshRelays.id, relayId), eq(sshRelays.gatewayInstanceId, parsedGatewayInstanceId)))
        .for('update')
        .limit(1)
      if (!relay) {
        throw sshNotFound('SSH relay not found.', {
          relayId,
        })
      }
      if (relay.status === SshRelayStatus.CLOSED && relay.closedAt !== null) {
        return SshRelayCloseOutputSchema.parse({
          relayId: relay.id,
          closedAt: toIsoTimestamp(relay.closedAt, 'closedAt', relay.id),
        })
      }
      const now = new Date()
      const closingAt = relay.closingAt ?? now
      const closureReason = relay.closureReason ?? parsedReason
      const [closed] = await tx
        .update(sshRelays)
        .set({
          status: SshRelayStatus.CLOSED,
          closingAt,
          closedAt: now,
          closureReason,
        })
        .where(and(eq(sshRelays.id, relay.id), eq(sshRelays.gatewayInstanceId, parsedGatewayInstanceId)))
        .returning({
          id: sshRelays.id,
          closedAt: sshRelays.closedAt,
        })
      if (!closed?.closedAt) {
        throw sshConflict('Failed to persist SSH relay closure.', {
          relayId,
        })
      }
      return SshRelayCloseOutputSchema.parse({
        relayId: closed.id,
        closedAt: toIsoTimestamp(closed.closedAt, 'closedAt', closed.id),
      })
    })
  }

  private async lockEligibleBinding(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    key: SshCanonicalPublicKey,
  ) {
    const [registeredKey] = await tx
      .select()
      .from(sshPublicKeys)
      .where(
        and(
          eq(sshPublicKeys.algorithm, key.algorithm),
          eq(sshPublicKeys.publicKeyBlob, key.publicKeyBlob),
          eq(sshPublicKeys.fingerprint, key.fingerprint),
        ),
      )
      .for('update')
      .limit(1)

    if (!registeredKey || registeredKey.status !== SshPublicKeyStatus.ACTIVE) {
      throw sshForbidden('The offered SSH public key is not eligible.')
    }
    this.relays.assertCanonicalKeyMatches(registeredKey, key)
    const grants = await tx
      .select()
      .from(sshBranchGrants)
      .where(
        and(eq(sshBranchGrants.publicKeyId, registeredKey.id), eq(sshBranchGrants.status, SshBranchGrantStatus.ACTIVE)),
      )
      .for('update')
      .limit(2)
    if (grants.length !== 1) {
      throw sshForbidden('The offered SSH public key does not have exactly one active branch grant.')
    }
    const grant = grants[0]!
    await this.lockAndValidateDestination(tx, {
      userId: registeredKey.ownerUserId,
      capsuleId: grant.capsuleId,
      branchId: grant.branchId,
      registeredKey,
      grant,
    })
    return {
      key: registeredKey,
      grant,
      branch: {
        id: grant.branchId,
        capsuleId: grant.capsuleId,
      },
    }
  }

  private async lockAndValidateDestination(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    binding: SshAuthorizedBinding,
  ) {
    const [branch] = await tx
      .select()
      .from(capsuleBranches)
      .where(and(eq(capsuleBranches.id, binding.branchId), eq(capsuleBranches.capsuleId, binding.capsuleId)))
      .for('update')
      .limit(1)
    const [capsule] = await tx.select().from(capsules).where(eq(capsules.id, binding.capsuleId)).for('update').limit(1)
    const [access] = await tx
      .select()
      .from(sshBranchAccess)
      .where(eq(sshBranchAccess.branchId, binding.branchId))
      .for('update')
      .limit(1)
    if (
      binding.registeredKey.status !== SshPublicKeyStatus.ACTIVE ||
      binding.grant.status !== SshBranchGrantStatus.ACTIVE ||
      binding.registeredKey.ownerUserId !== binding.userId ||
      binding.grant.publicKeyId !== binding.registeredKey.id ||
      binding.grant.keyOwnerUserId !== binding.registeredKey.ownerUserId ||
      binding.grant.keyOwnerUserId !== binding.userId ||
      binding.grant.capsuleId !== binding.capsuleId ||
      binding.grant.branchId !== binding.branchId ||
      !branch ||
      !capsule ||
      !access ||
      branch.id !== binding.grant.branchId ||
      branch.capsuleId !== binding.grant.capsuleId ||
      branch.capsuleId !== capsule.id ||
      branch.ownerId !== capsule.ownerId ||
      branch.ownerId !== binding.grant.capsuleOwnerUserId ||
      capsule.ownerId !== binding.grant.capsuleOwnerUserId ||
      branch.status !== 'online' ||
      capsule.lifecycleStatus !== 'active' ||
      capsule.archivedAt !== null ||
      access.state !== SshBranchAccessState.ENABLED
    ) {
      throw sshForbidden('SSH access is not currently eligible for this editable branch.', {
        userId: binding.userId,
        capsuleId: binding.capsuleId,
        branchId: binding.branchId,
        branchStatus: branch?.status ?? null,
        capsuleLifecycleStatus: capsule?.lifecycleStatus ?? null,
        accessState: access?.state ?? null,
      })
    }
    const runtimeIp = branch.runtimeIp
    if (runtimeIp === null || isIP(runtimeIp) === 0) {
      throw sshConflict('The online branch has no valid Host-authorized private SSH destination.', {
        capsuleId: binding.capsuleId,
        branchId: binding.branchId,
      })
    }
    return SshBranchDestinationSchema.parse({
      host: runtimeIp,
      port: 22,
    })
  }

  private hashTicket(ticket: string): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(ticket, 'utf8').digest('hex')}`
  }
}
