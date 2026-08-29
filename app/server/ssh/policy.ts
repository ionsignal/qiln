import type {
  SshBranchAccessInitializationReason,
  SshBranchAccessMutationOutput,
  SshBranchAccessRevocationReason,
  SshBranchGrantSummary,
  SshCanonicalPublicKey,
  SshCapsuleAccessRevocationOutput,
  SshCapsuleAccessRevocationReason,
  SshGatewayKeyEligibilityOutput,
  SshOpenSshConfigOutput,
  SshPublicKeyRegistration,
  SshPublicKeySummary,
  SshRelayActivationOutput,
  SshRelayCloseOutput,
  SshRelayOpening,
  SshTicketIssueOutput,
} from '@qiln/core/server'
import { SshBranchAccessService } from './access'
import { sshForbidden } from './errors'
import { SshBranchGrantService } from './grants'
import { SshPublicKeyService } from './keys'
import { SshRelayCoordinator, type SshRelayCloser } from './relays'
import type { SshAuthorizedKeysSyncDispatcher } from './sync'
import { SshTicketService } from './tickets'
import type { Database } from '@server/db'
import type { SshConfig } from '@/types/config'

export class SshHostPolicy {
  public readonly keys: SshPublicKeyService
  public readonly grants: SshBranchGrantService
  public readonly access: SshBranchAccessService
  public readonly tickets: SshTicketService

  private readonly relays: SshRelayCoordinator

  constructor(
    database: Database,
    private readonly config: SshConfig,
    authorizedKeysSync: SshAuthorizedKeysSyncDispatcher,
  ) {
    this.relays = new SshRelayCoordinator(database, config.relayClosureTimeoutMs)
    this.keys = new SshPublicKeyService(database, this.relays, authorizedKeysSync)
    this.grants = new SshBranchGrantService(database, this.relays, config, authorizedKeysSync)
    this.access = new SshBranchAccessService(database, this.relays, authorizedKeysSync)
    this.tickets = new SshTicketService(database, this.relays, config.ticketTtlMs)
  }

  public setRelayCloser(closer: SshRelayCloser): void {
    this.relays.setCloser(closer)
  }

  public recoverGatewayRelays(gatewayInstanceId: string): Promise<number> {
    this.assertEnabled()
    return this.relays.recoverGatewayRelays(gatewayInstanceId)
  }

  public registerPublicKey(userId: string, input: SshPublicKeyRegistration): Promise<SshPublicKeySummary> {
    this.assertEnabled()
    return this.keys.register(userId, input)
  }

  public listPublicKeys(userId: string): Promise<SshPublicKeySummary[]> {
    this.assertEnabled()
    return this.keys.list(userId)
  }

  public revokePublicKey(userId: string, publicKeyId: string): Promise<SshPublicKeySummary> {
    this.assertEnabled()
    return this.keys.revoke(userId, publicKeyId)
  }

  public bindGrant(adminUserId: string, publicKeyId: string, branchId: string): Promise<SshBranchGrantSummary> {
    this.assertEnabled()
    return this.grants.bind(adminUserId, publicKeyId, branchId)
  }

  public revokeGrant(adminUserId: string, grantId: string): Promise<SshBranchGrantSummary> {
    this.assertEnabled()
    return this.grants.revoke(adminUserId, grantId)
  }

  public listGrants(adminUserId: string): Promise<SshBranchGrantSummary[]> {
    this.assertEnabled()
    return this.grants.listAll(adminUserId)
  }

  public generateOpenSshConfig(userId: string, publicKeyId: string): Promise<SshOpenSshConfigOutput> {
    this.assertEnabled()
    return this.grants.generateOpenSshConfig(userId, publicKeyId)
  }

  public initializeBranchAccess(
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
    reason: SshBranchAccessInitializationReason,
  ): Promise<SshBranchAccessMutationOutput> {
    this.assertEnabled()
    return this.access.initializeBlocked(ownerUserId, capsuleId, branchId, reason)
  }

  public enableBranchAccess(
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<SshBranchAccessMutationOutput> {
    this.assertEnabled()
    return this.access.enable(ownerUserId, capsuleId, branchId)
  }

  public revokeBranchAccess(
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
    reason: SshBranchAccessRevocationReason,
  ): Promise<SshBranchAccessMutationOutput> {
    this.assertEnabled()
    return this.access.revokeBranch(ownerUserId, capsuleId, branchId, reason)
  }

  public revokeCapsuleAccess(
    ownerUserId: string,
    capsuleId: string,
    reason: SshCapsuleAccessRevocationReason,
  ): Promise<SshCapsuleAccessRevocationOutput> {
    this.assertEnabled()
    return this.access.revokeCapsule(ownerUserId, capsuleId, reason)
  }

  public checkGatewayKeyEligibility(key: SshCanonicalPublicKey): Promise<SshGatewayKeyEligibilityOutput> {
    this.assertEnabled()
    return this.tickets.checkEligibility(key)
  }

  public issueGatewayTicket(key: SshCanonicalPublicKey): Promise<SshTicketIssueOutput> {
    this.assertEnabled()
    return this.tickets.issue(key)
  }

  public redeemGatewayTicket(
    ticket: string,
    key: SshCanonicalPublicKey,
    gatewayInstanceId: string,
  ): Promise<SshRelayOpening> {
    this.assertEnabled()
    return this.tickets.redeem(ticket, key, gatewayInstanceId)
  }

  public activateRelay(relayId: string, gatewayInstanceId: string): Promise<SshRelayActivationOutput> {
    this.assertEnabled()
    return this.tickets.activate(relayId, gatewayInstanceId)
  }

  public closeRelay(relayId: string, gatewayInstanceId: string, reason: string): Promise<SshRelayCloseOutput> {
    this.assertEnabled()
    return this.tickets.close(relayId, gatewayInstanceId, reason)
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw sshForbidden('SSH access is disabled by Host policy.', {
        feature: 'ssh_access',
      })
    }
  }
}
