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
    this.assertAccessEnabled()
    return this.relays.recoverGatewayRelays(gatewayInstanceId)
  }

  public registerPublicKey(userId: string, input: SshPublicKeyRegistration): Promise<SshPublicKeySummary> {
    this.assertAccessEnabled()
    return this.keys.register(userId, input)
  }

  public listPublicKeys(userId: string): Promise<SshPublicKeySummary[]> {
    this.assertAccessEnabled()
    return this.keys.list(userId)
  }

  public revokePublicKey(userId: string, publicKeyId: string): Promise<SshPublicKeySummary> {
    this.assertAccessEnabled()
    return this.keys.revoke(userId, publicKeyId)
  }

  public bindGrant(adminUserId: string, publicKeyId: string, branchId: string): Promise<SshBranchGrantSummary> {
    this.assertAccessEnabled()
    return this.grants.bind(adminUserId, publicKeyId, branchId)
  }

  public revokeGrant(adminUserId: string, grantId: string): Promise<SshBranchGrantSummary> {
    this.assertAccessEnabled()
    return this.grants.revoke(adminUserId, grantId)
  }

  public listGrants(adminUserId: string): Promise<SshBranchGrantSummary[]> {
    this.assertAccessEnabled()
    return this.grants.listAll(adminUserId)
  }

  public generateOpenSshConfig(userId: string, publicKeyId: string): Promise<SshOpenSshConfigOutput> {
    this.assertAccessEnabled()
    return this.grants.generateOpenSshConfig(userId, publicKeyId)
  }

  /**
   * Initializes the fail-closed fence even when interactive SSH access is
   * disabled. Capsule creation and fork safety must not depend on the optional
   * SSH access feature being enabled.
   */
  public initializeBranchAccess(
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
    reason: SshBranchAccessInitializationReason,
  ): Promise<SshBranchAccessMutationOutput> {
    return this.access.initializeBlocked(ownerUserId, capsuleId, branchId, reason)
  }

  public enableBranchAccess(
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<SshBranchAccessMutationOutput> {
    this.assertAccessEnabled()
    return this.access.enable(ownerUserId, capsuleId, branchId)
  }

  /**
   * Revocation remains available while SSH access is disabled so lifecycle
   * safety paths can continue closing grants, tickets, and relays.
   */
  public revokeBranchAccess(
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
    reason: SshBranchAccessRevocationReason,
  ): Promise<SshBranchAccessMutationOutput> {
    return this.access.revokeBranch(ownerUserId, capsuleId, branchId, reason)
  }

  /**
   * Capsule-wide revocation is a safety operation rather than an access-
   * granting operation and therefore remains available while SSH is disabled.
   */
  public revokeCapsuleAccess(
    ownerUserId: string,
    capsuleId: string,
    reason: SshCapsuleAccessRevocationReason,
  ): Promise<SshCapsuleAccessRevocationOutput> {
    return this.access.revokeCapsule(ownerUserId, capsuleId, reason)
  }

  public checkGatewayKeyEligibility(key: SshCanonicalPublicKey): Promise<SshGatewayKeyEligibilityOutput> {
    this.assertAccessEnabled()
    return this.tickets.checkEligibility(key)
  }

  public issueGatewayTicket(key: SshCanonicalPublicKey): Promise<SshTicketIssueOutput> {
    this.assertAccessEnabled()
    return this.tickets.issue(key)
  }

  public redeemGatewayTicket(
    ticket: string,
    key: SshCanonicalPublicKey,
    gatewayInstanceId: string,
  ): Promise<SshRelayOpening> {
    this.assertAccessEnabled()
    return this.tickets.redeem(ticket, key, gatewayInstanceId)
  }

  public activateRelay(relayId: string, gatewayInstanceId: string): Promise<SshRelayActivationOutput> {
    this.assertAccessEnabled()
    return this.tickets.activate(relayId, gatewayInstanceId)
  }

  /**
   * Relay closure remains available after SSH has been disabled. Disabling
   * access must never prevent cleanup of a relay that was already opened.
   */
  public closeRelay(relayId: string, gatewayInstanceId: string, reason: string): Promise<SshRelayCloseOutput> {
    return this.tickets.close(relayId, gatewayInstanceId, reason)
  }

  private assertAccessEnabled(): void {
    if (!this.config.enabled) {
      throw sshForbidden('SSH access is disabled by Host policy.', {
        feature: 'ssh_access',
      })
    }
  }
}
