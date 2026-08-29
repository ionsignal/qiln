import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import type { SshRelayClosureOrigin, SshRelayRegistrationResult, SshRelayRegistryState } from './types'

interface SshRelayRegistryRecord {
  relayId: string
  state: SshRelayRegistryState
  channel: Duplex
  upstream: Socket | null
  onClose: (origin: SshRelayClosureOrigin) => void | Promise<void>
}

interface SshRelayRegistryOptions {
  maxRelays: number
  maxTombstones: number
  tombstoneTtlMs: number
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`)
  }
}

/**
 * Process-local relay and revocation registry for one gateway instance.
 *
 * Tombstones close the redemption-to-registration race: if Host revocation
 * selects an opening relay before the gateway registers it, the later
 * registration is rejected locally and can never dial a branch.
 */
export class SshRelayRegistry {
  private readonly relays = new Map<string, SshRelayRegistryRecord>()
  private readonly tombstones = new Map<string, number>()
  private readonly maxRelays: number
  private readonly maxTombstones: number
  private readonly tombstoneTtlMs: number

  constructor(options: SshRelayRegistryOptions) {
    assertPositiveSafeInteger(options.maxRelays, 'SSH gateway max relays')
    assertPositiveSafeInteger(options.maxTombstones, 'SSH gateway max relay tombstones')
    assertPositiveSafeInteger(options.tombstoneTtlMs, 'SSH gateway relay tombstone TTL')

    this.maxRelays = options.maxRelays
    this.maxTombstones = options.maxTombstones
    this.tombstoneTtlMs = options.tombstoneTtlMs
  }

  public get activeRelayCount(): number {
    return this.relays.size
  }

  public get tombstoneCount(): number {
    this.pruneTombstones()
    return this.tombstones.size
  }

  public register(
    relayId: string,
    channel: Duplex,
    onClose: (origin: SshRelayClosureOrigin) => void | Promise<void>,
  ): SshRelayRegistrationResult {
    this.pruneTombstones()
    if (this.tombstones.has(relayId)) {
      channel.destroy()
      return 'tombstoned'
    }
    if (this.relays.has(relayId)) {
      channel.destroy()
      this.addTombstone(relayId)
      return 'tombstoned'
    }
    if (this.relays.size >= this.maxRelays) {
      channel.destroy()
      return 'capacity'
    }
    this.relays.set(relayId, {
      relayId,
      state: 'registered',
      channel,
      upstream: null,
      onClose,
    })
    return 'registered'
  }

  public beginDial(relayId: string): boolean {
    const relay = this.relays.get(relayId)
    if (!relay || relay.state !== 'registered' || this.isTombstoned(relayId)) {
      return false
    }
    relay.state = 'dialing'
    return true
  }

  /**
   * Attaches the connecting upstream socket before waiting for `connect`.
   *
   * Host revocation can therefore destroy a socket while the dial is still in
   * progress. A socket created after closure is destroyed immediately.
   */
  public attachUpstream(relayId: string, upstream: Socket): boolean {
    const relay = this.relays.get(relayId)
    if (!relay || relay.state !== 'dialing' || this.isTombstoned(relayId)) {
      upstream.destroy()
      return false
    }
    relay.upstream = upstream
    return true
  }

  public activate(relayId: string): boolean {
    const relay = this.relays.get(relayId)
    if (
      !relay ||
      relay.state !== 'dialing' ||
      relay.upstream === null ||
      relay.upstream.destroyed ||
      this.isTombstoned(relayId)
    ) {
      relay?.upstream?.destroy()
      return false
    }
    relay.state = 'active'
    return true
  }

  public close(relayId: string, origin: SshRelayClosureOrigin): boolean {
    const relay = this.relays.get(relayId)
    if (!relay) {
      this.addTombstone(relayId)
      return false
    }
    this.relays.delete(relayId)
    this.addTombstone(relayId)
    relay.channel.destroy()
    relay.upstream?.destroy()
    try {
      const completion = relay.onClose(origin)
      void Promise.resolve(completion).catch(() => undefined)
    } catch {
      // Local socket closure is authoritative even if durable notification fails.
    }
    return true
  }

  /**
   * Implements the Host relay-closer interface.
   *
   * Unknown IDs are successfully tombstoned. This is required when revocation
   * reaches an opening durable relay before local registration.
   */
  public async closeRelayIds(relayIds: readonly string[]): Promise<readonly string[]> {
    const uniqueRelayIds = [...new Set(relayIds)]
    for (const relayId of uniqueRelayIds) {
      this.close(relayId, 'host')
    }
    return uniqueRelayIds
  }

  public closeAll(origin: SshRelayClosureOrigin): readonly string[] {
    const relayIds = [...this.relays.keys()]
    for (const relayId of relayIds) {
      this.close(relayId, origin)
    }
    return relayIds
  }

  private isTombstoned(relayId: string): boolean {
    this.pruneTombstones()
    return this.tombstones.has(relayId)
  }

  private addTombstone(relayId: string): void {
    this.pruneTombstones()
    this.tombstones.delete(relayId)
    this.tombstones.set(relayId, Date.now() + this.tombstoneTtlMs)
    while (this.tombstones.size > this.maxTombstones) {
      const oldestRelayId = this.tombstones.keys().next().value
      if (typeof oldestRelayId !== 'string') {
        break
      }
      this.tombstones.delete(oldestRelayId)
    }
  }

  private pruneTombstones(): void {
    const now = Date.now()
    for (const [relayId, expiresAt] of this.tombstones) {
      if (expiresAt <= now) {
        this.tombstones.delete(relayId)
      }
    }
  }
}
