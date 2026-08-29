import { createConnection, createServer, isIP, type Server as NetServer, type Socket } from 'node:net'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import { Server as SshServer, utils as ssh2Utils } from 'ssh2'
import {
  SshGatewayInstanceIdSchema,
  type SshCanonicalPublicKey,
  type SshRelayActivationOutput,
} from '@qiln/core/server'
import { authenticateGatewayPublicKey } from './auth'
import { SshRelayRegistry } from './relay'
import type { AuthContext, Connection, PublicKeyAuthContext, ServerChannel, ServerConfig, Session } from 'ssh2'
import type { SshGatewayConfig, SshGatewayHostPolicy, SshGatewayStats, SshRelayClosureOrigin } from './types'

const EVENT_LOOP_DELAY_RESOLUTION_MS = 20

const RELAY_REGISTRATION_REJECTED_REASON = 'gateway_registration_rejected'
const RELAY_SETUP_FAILED_REASON = 'gateway_setup_failed'
const RELAY_STREAM_CLOSED_REASON = 'gateway_stream_closed'
const RELAY_SHUTDOWN_REASON = 'gateway_shutdown'

const GATEWAY_IDENT = 'Qiln-SSH-Gateway'

const SSH_GATEWAY_SERVER_ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group18-sha512',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group14-sha256',
  ],
  serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
  cipher: [
    'chacha20-poly1305@openssh.com',
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
  ],
  hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512'],
  compress: ['none'],
} satisfies NonNullable<ServerConfig['algorithms']>

const SSH_GATEWAY_HOST_KEY_TYPES: ReadonlySet<string> = new Set(SSH_GATEWAY_SERVER_ALGORITHMS.serverHostKey)

interface GatewayConnectionState {
  socket: Socket
  client: Connection | null
  closed: boolean
  authInFlight: boolean
  authenticated: boolean
  sessionAccepted: boolean
  shellAccepted: boolean
  ticket: string | null
  key: SshCanonicalPublicKey | null
  relayId: string | null
  authenticationTimer: ReturnType<typeof setTimeout> | null
  channelTimer: ReturnType<typeof setTimeout> | null
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`)
  }
}

function validateGatewayConfig(config: SshGatewayConfig): void {
  if (config.bindHost.trim() === '') {
    throw new Error('SSH gateway bind host cannot be empty.')
  }
  if (!Number.isSafeInteger(config.bindPort) || config.bindPort < 1 || config.bindPort > 65_535) {
    throw new RangeError('SSH gateway bind port must be an integer between 1 and 65535.')
  }
  SshGatewayInstanceIdSchema.parse(config.gatewayInstanceId)

  assertPositiveSafeInteger(config.maxConnections, 'SSH gateway max connections')
  assertPositiveSafeInteger(config.maxRelays, 'SSH gateway max relays')
  assertPositiveSafeInteger(config.authenticationTimeoutMs, 'SSH gateway authentication timeout')
  assertPositiveSafeInteger(config.channelOpenTimeoutMs, 'SSH gateway channel-open timeout')
  assertPositiveSafeInteger(config.branchDialTimeoutMs, 'SSH gateway branch-dial timeout')

  if (config.maxRelays > config.maxConnections) {
    throw new RangeError('SSH gateway max relays cannot exceed max incoming connections.')
  }
  if (config.hostKeys.length === 0) {
    throw new Error('SSH gateway requires at least one persistent host key.')
  }
  for (const hostKey of config.hostKeys) {
    const parsed = ssh2Utils.parseKey(hostKey)
    if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey()) {
      throw new Error('SSH gateway persistent host key is invalid or does not contain private key material.')
    }
    if (!SSH_GATEWAY_HOST_KEY_TYPES.has(parsed.type)) {
      throw new Error(
        `SSH gateway host key type '${parsed.type}' is not permitted. Use an Ed25519 or supported ECDSA persistent host key.`,
      )
    }
  }
}

/**
 * Fail-closed ssh2 gateway for one Host process.
 *
 * The outer SSH connection terminates here. The accepted shell channel carries
 * the untouched inner SSH byte stream to exactly one Host-authorized branch
 * destination.
 */
export class QilnSshGateway {
  private readonly registry: SshRelayRegistry
  private readonly incomingSockets = new Set<Socket>()
  private readonly protocolServers = new Set<SshServer>()
  private readonly durableClosureTasks = new Set<Promise<void>>()
  private readonly eventLoopDelay: IntervalHistogram

  private listener: NetServer | null = null
  private started = false
  private stopping = false
  private authenticatedConnections = 0
  private authRejections = 0
  private dialFailures = 0

  constructor(
    private readonly config: SshGatewayConfig,
    private readonly policy: SshGatewayHostPolicy,
  ) {
    validateGatewayConfig(config)
    const tombstoneTtlMs =
      config.authenticationTimeoutMs + config.channelOpenTimeoutMs + config.branchDialTimeoutMs + 60_000
    this.registry = new SshRelayRegistry({
      maxRelays: config.maxRelays,
      maxTombstones: Math.max(config.maxConnections * 2, config.maxRelays * 4),
      tombstoneTtlMs,
    })
    this.eventLoopDelay = monitorEventLoopDelay({
      resolution: EVENT_LOOP_DELAY_RESOLUTION_MS,
    })
  }

  public get stats(): SshGatewayStats {
    return {
      listening: this.started && !this.stopping,
      incomingConnections: this.incomingSockets.size,
      authenticatedConnections: this.authenticatedConnections,
      activeRelays: this.registry.activeRelayCount,
      relayTombstones: this.registry.tombstoneCount,
      authRejections: this.authRejections,
      dialFailures: this.dialFailures,
      eventLoopLagMeanMs: Number.isFinite(this.eventLoopDelay.mean) ? this.eventLoopDelay.mean / 1_000_000 : 0,
      eventLoopLagMaxMs: Number.isFinite(this.eventLoopDelay.max) ? this.eventLoopDelay.max / 1_000_000 : 0,
    }
  }

  public async start(): Promise<void> {
    if (this.started) {
      return
    }
    if (this.stopping) {
      throw new Error('SSH gateway cannot start while shutdown is in progress.')
    }
    const listener = createServer(socket => {
      this.acceptSocket(socket)
    })
    listener.maxConnections = this.config.maxConnections
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        listener.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        listener.off('error', onError)
        resolve()
      }
      listener.once('error', onError)
      listener.once('listening', onListening)
      listener.listen({
        host: this.config.bindHost,
        port: this.config.bindPort,
      })
    })
    this.listener = listener
    this.started = true
    this.eventLoopDelay.enable()
  }

  public async stop(): Promise<void> {
    if (this.stopping) {
      await this.waitForDurableClosures()
      return
    }
    this.stopping = true
    this.started = false
    this.eventLoopDelay.disable()
    const listener = this.listener
    this.listener = null
    const listenerClosed = listener
      ? new Promise<void>(resolve => {
          listener.close(() => resolve())
        })
      : Promise.resolve()
    this.registry.closeAll('shutdown')
    for (const socket of this.incomingSockets) {
      socket.destroy()
    }
    await listenerClosed
    await this.waitForDurableClosures()
    this.protocolServers.clear()
    this.stopping = false
  }

  public async closeRelayIds(relayIds: readonly string[]): Promise<readonly string[]> {
    return await this.registry.closeRelayIds(relayIds)
  }

  private acceptSocket(socket: Socket): void {
    if (this.stopping || this.incomingSockets.size >= this.config.maxConnections) {
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    socket.setKeepAlive(true)
    this.incomingSockets.add(socket)
    const state: GatewayConnectionState = {
      socket,
      client: null,
      closed: false,
      authInFlight: false,
      authenticated: false,
      sessionAccepted: false,
      shellAccepted: false,
      ticket: null,
      key: null,
      relayId: null,
      authenticationTimer: null,
      channelTimer: null,
    }
    const protocolServer = new SshServer(
      {
        hostKeys: [...this.config.hostKeys],
        ident: GATEWAY_IDENT,
        algorithms: SSH_GATEWAY_SERVER_ALGORITHMS,
      },
      client => {
        state.client = client
        this.configureClient(client, state)
      },
    )
    this.protocolServers.add(protocolServer)
    protocolServer.on('error', () => {
      socket.destroy()
    })
    socket.once('close', () => {
      state.closed = true
      this.clearTimers(state)
      this.incomingSockets.delete(socket)
      this.protocolServers.delete(protocolServer)
      if (state.authenticated) {
        this.authenticatedConnections = Math.max(0, this.authenticatedConnections - 1)
      }
      if (state.relayId) {
        this.registry.close(state.relayId, 'natural')
      }
    })
    state.authenticationTimer = setTimeout(() => {
      state.closed = true
      socket.destroy()
    }, this.config.authenticationTimeoutMs)
    protocolServer.injectSocket(socket)
  }

  private configureClient(client: Connection, state: GatewayConnectionState): void {
    client.on('authentication', context => {
      this.handleAuthentication(context, state)
    })
    client.on('ready', () => {
      if (!state.authenticated || state.ticket === null || state.key === null) {
        client.end()
        return
      }
      state.channelTimer = setTimeout(() => {
        client.end()
      }, this.config.channelOpenTimeoutMs)
    })
    client.on('session', (accept, reject) => {
      if (
        state.closed ||
        !state.authenticated ||
        state.ticket === null ||
        state.key === null ||
        state.sessionAccepted
      ) {
        reject()
        return
      }
      state.sessionAccepted = true
      const session = accept()
      this.configureSession(session, state)
    })
    client.on('tcpip', (_accept, reject) => {
      reject()
    })
    client.on('error', () => {
      state.socket.destroy()
    })
    client.on('close', () => {
      state.socket.destroy()
    })
  }

  private handleAuthentication(context: AuthContext, state: GatewayConnectionState): void {
    if (state.closed || state.authenticated || state.authInFlight || context.method !== 'publickey') {
      this.authRejections++
      context.reject()
      return
    }
    state.authInFlight = true
    void authenticateGatewayPublicKey(context as PublicKeyAuthContext, this.policy)
      .then(result => {
        if (state.closed || state.socket.destroyed) {
          context.reject()
          return
        }
        if (result.kind === 'probe_accepted') {
          context.accept()
          return
        }
        if (result.kind !== 'authenticated') {
          this.authRejections++
          context.reject()
          return
        }
        if (this.authenticatedConnections >= this.config.maxConnections) {
          this.authRejections++
          context.reject()
          return
        }
        state.authenticated = true
        state.ticket = result.ticket
        state.key = result.key
        this.authenticatedConnections++
        this.clearAuthenticationTimer(state)
        context.accept()
      })
      .catch(() => {
        this.authRejections++
        context.reject()
      })
      .finally(() => {
        state.authInFlight = false
      })
  }

  private configureSession(session: Session, state: GatewayConnectionState): void {
    session.on('pty', (_accept, reject) => reject())
    session.on('env', (_accept, reject) => reject())
    session.on('exec', (_accept, reject) => reject())
    session.on('subsystem', (_accept, reject) => reject())
    session.on('x11', (_accept, reject) => reject())
    session.on('auth-agent', (_accept, reject) => reject())
    session.on('signal', (_accept, reject) => reject())
    session.on('window-change', (_accept, reject) => reject())
    session.on('shell', (accept, reject) => {
      if (
        state.closed ||
        state.shellAccepted ||
        state.ticket === null ||
        state.key === null ||
        this.registry.activeRelayCount >= this.config.maxRelays
      ) {
        reject()
        return
      }
      state.shellAccepted = true
      this.clearChannelTimer(state)
      const channel = accept()
      channel.pause()
      const ticket = state.ticket
      const key = state.key
      state.ticket = null
      void this.openRelay(state, channel, ticket, key)
    })
  }

  private async openRelay(
    state: GatewayConnectionState,
    channel: ServerChannel,
    ticket: string,
    key: SshCanonicalPublicKey,
  ): Promise<void> {
    let relayId: string | null = null
    try {
      const opening = await this.policy.redeemGatewayTicket(ticket, key, this.config.gatewayInstanceId)
      relayId = opening.relayId
      state.relayId = relayId
      const registration = this.registry.register(relayId, channel, origin => {
        this.onRelayClosed(relayId!, origin)
      })
      if (registration !== 'registered') {
        this.trackDurableClosure(
          this.policy.closeRelay(relayId, this.config.gatewayInstanceId, RELAY_REGISTRATION_REJECTED_REASON),
          relayId,
        )
        state.client?.end()
        return
      }
      channel.once('error', () => {
        this.registry.close(relayId!, 'natural')
      })
      channel.once('close', () => {
        this.registry.close(relayId!, 'natural')
      })
      channel.once('end', () => {
        this.registry.close(relayId!, 'natural')
      })
      const activation = await this.policy.activateRelay(relayId, this.config.gatewayInstanceId)
      if (!this.registry.beginDial(relayId)) {
        throw new Error('SSH relay was closed before branch dialing could begin.')
      }
      const upstream = await this.dialBranch(relayId, activation)
      if (!this.registry.activate(relayId)) {
        upstream.destroy()
        throw new Error('SSH relay was closed before the branch connection became usable.')
      }
      channel.pipe(upstream)
      upstream.pipe(channel)
      channel.resume()
    } catch {
      this.dialFailures++
      if (relayId !== null) {
        this.registry.close(relayId, 'setup_failure')
      } else {
        channel.destroy()
      }
      state.client?.end()
    }
  }

  private async dialBranch(relayId: string, activation: SshRelayActivationOutput): Promise<Socket> {
    if (isIP(activation.destination.host) === 0 || activation.destination.port !== 22) {
      throw new Error('Host policy returned an invalid SSH branch destination.')
    }
    const upstream = createConnection({
      host: activation.destination.host,
      port: activation.destination.port,
    })
    upstream.setNoDelay(true)
    upstream.setKeepAlive(true)
    if (!this.registry.attachUpstream(relayId, upstream)) {
      upstream.destroy()
      throw new Error('SSH relay was closed while its branch socket was being created.')
    }
    upstream.once('close', () => {
      this.registry.close(relayId, 'natural')
    })
    return await new Promise<Socket>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        finish(new Error('SSH branch connection timed out.'))
      }, this.config.branchDialTimeoutMs)
      const finish = (error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        upstream.off('connect', onConnect)
        upstream.off('error', onError)
        upstream.off('close', onCloseBeforeConnect)
        if (error) {
          upstream.destroy()
          reject(error)
          return
        }
        resolve(upstream)
      }
      const onConnect = () => finish()
      const onError = () => finish(new Error('SSH branch connection failed.'))
      const onCloseBeforeConnect = () => finish(new Error('SSH branch connection closed before activation.'))
      upstream.once('connect', onConnect)
      upstream.once('error', onError)
      upstream.once('close', onCloseBeforeConnect)
    })
  }

  private onRelayClosed(relayId: string, origin: SshRelayClosureOrigin): void {
    if (origin === 'host') {
      return
    }
    const reason =
      origin === 'shutdown'
        ? RELAY_SHUTDOWN_REASON
        : origin === 'setup_failure'
          ? RELAY_SETUP_FAILED_REASON
          : RELAY_STREAM_CLOSED_REASON
    this.trackDurableClosure(this.policy.closeRelay(relayId, this.config.gatewayInstanceId, reason), relayId)
  }

  private trackDurableClosure(operation: Promise<unknown>, relayId: string): void {
    const completion = operation
      .then(() => undefined)
      .catch(() => {
        throw new Error(`Failed to persist closure for SSH relay '${relayId}'.`)
      })
      .finally(() => {
        this.durableClosureTasks.delete(completion)
      })
    this.durableClosureTasks.add(completion)
    void completion.catch(() => undefined)
  }

  private async waitForDurableClosures(): Promise<void> {
    const results = await Promise.allSettled([...this.durableClosureTasks])
    if (results.some(result => result.status === 'rejected')) {
      throw new Error('One or more SSH relay closures could not be persisted during gateway shutdown.')
    }
  }

  private clearAuthenticationTimer(state: GatewayConnectionState): void {
    if (state.authenticationTimer !== null) {
      clearTimeout(state.authenticationTimer)
      state.authenticationTimer = null
    }
  }

  private clearChannelTimer(state: GatewayConnectionState): void {
    if (state.channelTimer !== null) {
      clearTimeout(state.channelTimer)
      state.channelTimer = null
    }
  }

  private clearTimers(state: GatewayConnectionState): void {
    this.clearAuthenticationTimer(state)
    this.clearChannelTimer(state)
  }
}
