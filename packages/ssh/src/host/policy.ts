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
import { SshTicketService } from './tickets'
import type { SshAuthorizedKeysSyncDispatcher } from './sync'
import type { SshPersistence } from '../db/persistence'
import type { SshPolicyConfig } from './types'

/**
 * Authority-gated SSH policy shared by RPC and gateway entrypoints.
 *
 * Services remain private so a caller cannot bypass runtime admission by
 * accessing a service directly. Accepted calls are tracked until completion
 * before the runtime releases its singleton authority.
 */
export class SshPolicy {
  private readonly keys: SshPublicKeyService
  private readonly grants: SshBranchGrantService
  private readonly access: SshBranchAccessService
  private readonly tickets: SshTicketService
  private readonly pending = new Set<Promise<unknown>>()

  private readonly relays: SshRelayCoordinator

  constructor(
    persistence: SshPersistence,
    private readonly config: SshPolicyConfig,
    authorizedKeysSync: SshAuthorizedKeysSyncDispatcher,
    private readonly assertAuthority: () => void,
  ) {
    this.relays = new SshRelayCoordinator(persistence, config.relayClosureTimeoutMs)
    this.keys = new SshPublicKeyService(persistence, this.relays, authorizedKeysSync)
    this.grants = new SshBranchGrantService(persistence, this.relays, config, authorizedKeysSync)
    this.access = new SshBranchAccessService(persistence, this.relays, authorizedKeysSync)
    this.tickets = new SshTicketService(persistence, this.relays, config.ticketTtlMs)
  }

  public setRelayCloser(closer: SshRelayCloser): void {
    this.relays.setCloser(closer)
  }

  public recoverGatewayRelays(gatewayInstanceId: string): Promise<number> {
    return this.run(() => this.relays.recoverGatewayRelays(gatewayInstanceId), true)
  }

  public registerPublicKey(userId: string, input: SshPublicKeyRegistration): Promise<SshPublicKeySummary> {
    return this.run(() => this.keys.register(userId, input), true)
  }

  public listPublicKeys(userId: string): Promise<SshPublicKeySummary[]> {
    return this.run(() => this.keys.list(userId), true)
  }

  public revokePublicKey(userId: string, publicKeyId: string): Promise<SshPublicKeySummary> {
    return this.run(() => this.keys.revoke(userId, publicKeyId), true)
  }

  public bindGrant(adminUserId: string, publicKeyId: string, branchId: string): Promise<SshBranchGrantSummary> {
    return this.run(() => this.grants.bind(adminUserId, publicKeyId, branchId), true)
  }

  public revokeGrant(adminUserId: string, grantId: string): Promise<SshBranchGrantSummary> {
    return this.run(() => this.grants.revoke(adminUserId, grantId), true)
  }

  public listGrants(adminUserId: string): Promise<SshBranchGrantSummary[]> {
    return this.run(() => this.grants.listAll(adminUserId), true)
  }

  public generateOpenSshConfig(userId: string, publicKeyId: string): Promise<SshOpenSshConfigOutput> {
    return this.run(() => this.grants.generateOpenSshConfig(userId, publicKeyId), true)
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
    return this.run(() => this.access.initializeBlocked(ownerUserId, capsuleId, branchId, reason))
  }

  public enableBranchAccess(
    ownerUserId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<SshBranchAccessMutationOutput> {
    return this.run(() => this.access.enable(ownerUserId, capsuleId, branchId), true)
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
    return this.run(() => this.access.revokeBranch(ownerUserId, capsuleId, branchId, reason))
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
    return this.run(() => this.access.revokeCapsule(ownerUserId, capsuleId, reason))
  }

  public checkGatewayKeyEligibility(key: SshCanonicalPublicKey): Promise<SshGatewayKeyEligibilityOutput> {
    return this.run(() => this.tickets.checkEligibility(key), true)
  }

  public issueGatewayTicket(key: SshCanonicalPublicKey): Promise<SshTicketIssueOutput> {
    return this.run(() => this.tickets.issue(key), true)
  }

  public redeemGatewayTicket(
    ticket: string,
    key: SshCanonicalPublicKey,
    gatewayInstanceId: string,
  ): Promise<SshRelayOpening> {
    return this.run(() => this.tickets.redeem(ticket, key, gatewayInstanceId), true)
  }

  public activateRelay(relayId: string, gatewayInstanceId: string): Promise<SshRelayActivationOutput> {
    return this.run(() => this.tickets.activate(relayId, gatewayInstanceId), true)
  }

  /**
   * Relay closure remains available after SSH has been disabled or runtime
   * admission has stopped. Cleanup of an already-opened relay must not depend
   * on permission to admit new work.
   */
  public closeRelay(relayId: string, gatewayInstanceId: string, reason: string): Promise<SshRelayCloseOutput> {
    return this.track(() => this.tickets.close(relayId, gatewayInstanceId, reason))
  }

  /**
   * Runtime admission must be stopped before draining. Gateway setup is drained
   * first so late redemption results cannot create untracked closure work.
   */
  public async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending])
    }
  }

  private run<T>(operation: () => Promise<T>, requiresAccess = false): Promise<T> {
    this.assertAuthority()
    if (requiresAccess) {
      this.assertAccessEnabled()
    }
    return this.track(operation)
  }

  private async track<T>(operation: () => Promise<T>): Promise<T> {
    const completion = Promise.resolve().then(operation)
    this.pending.add(completion)
    try {
      return await completion
    } finally {
      this.pending.delete(completion)
    }
  }

  private assertAccessEnabled(): void {
    if (!this.config.enabled) {
      throw sshForbidden('SSH access is disabled by SSH policy.', {
        feature: 'ssh_access',
      })
    }
  }
}
