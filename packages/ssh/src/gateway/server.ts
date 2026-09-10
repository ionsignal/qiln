import { randomUUID } from 'node:crypto'
import { createConnection, createServer, isIP, type Server as NetServer, type Socket } from 'node:net'
import { monitorEventLoopDelay, type ELDHistogram } from 'node:perf_hooks'
import {
  SSH_GATEWAY_DIAGNOSTIC_MARKER,
  SshGatewayDiagnosticCodeSchema,
  SshGatewayInstanceIdSchema,
  type SshCanonicalPublicKey,
  type SshGatewayDiagnostic,
  type SshGatewayDiagnosticError,
  type SshGatewayDiagnosticReason,
  type SshGatewayDiagnosticRequest,
  type SshGatewayDiagnosticStage,
  type SshRelayActivationOutput,
} from '@qiln/core/server'
import { ssh2Utils, SshServer } from '../ssh2'
import { authenticateGatewayPublicKey } from './auth'
import { SshRelayRegistry } from './relay'
import type { AuthContext, Connection, PublicKeyAuthContext, ServerChannel, ServerConfig, Session } from 'ssh2'
import type { SshGatewayConfig, SshGatewayPolicy, SshGatewayStats, SshRelayClosureOrigin } from './types'

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
  id: string
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

type GatewayDiagnosticInput = Omit<SshGatewayDiagnostic, 'gatewayInstanceId' | 'connectionId'>

class RelayError extends Error {
  constructor(public readonly reason: SshGatewayDiagnosticReason) {
    super('SSH relay setup failed.')
    this.name = 'RelayError'
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`)
  }
}

/**
 * Extracts only fixed error categories and allowlisted codes.
 *
 * Drizzle may wrap the useful PostgreSQL code in a cause. Inspecting a bounded
 * cause chain preserves that code without forwarding SQL, parameters, messages,
 * stacks, or nested error objects.
 */
function describeError(error: unknown): SshGatewayDiagnosticError {
  if (error instanceof TypeError) {
    return {
      kind: 'type_error',
    }
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return {
      kind: 'validation_error',
    }
  }
  let current = error
  for (let depth = 0; depth < 3; depth++) {
    if (typeof current !== 'object' || current === null) {
      break
    }
    if ('code' in current) {
      const code = SshGatewayDiagnosticCodeSchema.safeParse(current.code)
      if (code.success) {
        return {
          kind: 'coded_error',
          code: code.data,
        }
      }
    }
    if (!('cause' in current)) {
      break
    }
    current = current.cause
  }
  return {
    kind: 'unknown_error',
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
 * Fail-closed ssh2 gateway for one SSH authority process.
 *
 * The outer SSH connection terminates here. The accepted shell channel carries
 * the untouched inner SSH byte stream to exactly one policy-authorized branch
 * destination.
 */
export class QilnSshGateway {
  private readonly registry: SshRelayRegistry
  private readonly incomingSockets = new Set<Socket>()
  private readonly protocolServers = new Set<InstanceType<typeof SshServer>>()
  private readonly durableClosureTasks = new Set<Promise<void>>()
  private readonly setupTasks = new Set<Promise<void>>()
  private readonly eventLoopDelay: ELDHistogram

  private listener: NetServer | null = null
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private started = false
  private stopping = false
  private authenticatedConnections = 0
  private authRejections = 0
  private dialFailures = 0

  constructor(
    private readonly config: SshGatewayConfig,
    private readonly policy: SshGatewayPolicy,
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
    if (this.stopping) {
      throw new Error('A stopped SSH gateway cannot restart. Create a new gateway instance.')
    }
    if (this.started) {
      return
    }
    if (!this.startPromise) {
      this.startPromise = this.listen()
    }
    await this.startPromise
  }

  private async listen(): Promise<void> {
    const listener = createServer(socket => {
      this.acceptSocket(socket)
    })
    this.listener = listener
    listener.maxConnections = this.config.maxConnections
    listener.on('error', (error: Error) => {
      this.report(
        {
          stage: 'gateway',
          outcome: 'failed',
        },
        undefined,
        error,
      )
    })
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
    if (this.stopping) {
      return
    }
    this.started = true
    this.eventLoopDelay.enable()
    this.report({
      stage: 'gateway',
      outcome: 'started',
      marker: SSH_GATEWAY_DIAGNOSTIC_MARKER,
    })
  }

  public stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopping = true
      this.started = false
      this.eventLoopDelay.disable()
      this.registry.closeAll('shutdown')
      for (const socket of this.incomingSockets) {
        socket.destroy()
      }
      this.stopPromise = this.shutdown()
    }
    return this.stopPromise
  }

  private async shutdown(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined)
    }
    const listener = this.listener
    this.listener = null
    if (listener?.listening) {
      await new Promise<void>((resolve, reject) => {
        listener.close(error => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    }
    // Redemption may finish after sockets close. Its resulting relay must be
    // durably closed before the runtime can release singleton authority.
    while (this.setupTasks.size > 0) {
      await Promise.allSettled([...this.setupTasks])
    }
    await this.waitForDurableClosures()
    this.protocolServers.clear()
    this.report({
      stage: 'gateway',
      outcome: 'closed',
      reason: 'shutdown',
    })
  }

  public async closeRelayIds(relayIds: readonly string[]): Promise<readonly string[]> {
    return await this.registry.closeRelayIds(relayIds)
  }

  private acceptSocket(socket: Socket): void {
    if (this.stopping || this.incomingSockets.size >= this.config.maxConnections) {
      this.report({
        stage: 'connection',
        outcome: 'rejected',
        reason: this.stopping ? 'shutdown' : 'connection_limit',
      })
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    socket.setKeepAlive(true)
    this.incomingSockets.add(socket)
    const state: GatewayConnectionState = {
      id: randomUUID(),
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
    this.report({ stage: 'connection', outcome: 'accepted' }, state)
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
    protocolServer.on('error', (error: Error) => {
      this.report({ stage: 'connection', outcome: 'failed' }, state, error)
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
      this.report({ stage: 'connection', outcome: 'closed' }, state)
    })
    state.authenticationTimer = setTimeout(() => {
      this.report(
        {
          stage: 'authentication',
          outcome: 'timed_out',
          reason: 'authentication_timeout',
        },
        state,
      )
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
      if (this.stopping || state.closed || state.socket.destroyed) {
        state.socket.destroy()
        return
      }
      if (!state.authenticated || state.ticket === null || state.key === null) {
        this.report(
          {
            stage: 'authentication',
            outcome: 'failed',
            reason: !state.authenticated
              ? 'not_authenticated'
              : state.ticket === null
                ? 'missing_ticket'
                : 'missing_key',
          },
          state,
        )
        client.end()
        return
      }
      this.report({ stage: 'authentication', outcome: 'succeeded' }, state)
      state.channelTimer = setTimeout(() => {
        this.report(
          {
            stage: 'shell',
            outcome: 'timed_out',
            reason: 'channel_timeout',
          },
          state,
        )
        state.closed = true
        client.end()
      }, this.config.channelOpenTimeoutMs)
    })
    client.on('session', (accept, reject) => {
      this.report({ stage: 'session', outcome: 'started' }, state)
      const reason: SshGatewayDiagnosticReason | null = this.stopping
        ? 'shutdown'
        : state.closed || state.socket.destroyed
          ? 'connection_closed'
          : !state.authenticated
            ? 'not_authenticated'
            : state.ticket === null
              ? 'missing_ticket'
              : state.key === null
                ? 'missing_key'
                : state.sessionAccepted
                  ? 'session_already_accepted'
                  : null
      if (reason !== null) {
        this.report({ stage: 'session', outcome: 'rejected', reason }, state)
        reject()
        return
      }
      const session = accept()
      if (!session) {
        this.report(
          {
            stage: 'session',
            outcome: 'failed',
            reason: 'session_unavailable',
          },
          state,
        )
        state.socket.destroy()
        return
      }
      state.sessionAccepted = true
      this.configureSession(session, state)
      this.report({ stage: 'session', outcome: 'accepted' }, state)
    })
    client.on('tcpip', (_accept, reject) => {
      this.report(
        {
          stage: 'request',
          outcome: 'rejected',
          reason: 'unsupported_request',
          request: 'tcpip',
          replyRequested: true,
        },
        state,
      )
      reject()
    })
    client.on('error', (error: Error) => {
      this.report({ stage: 'connection', outcome: 'failed' }, state, error)
      state.socket.destroy()
    })
    client.on('close', () => {
      state.socket.destroy()
    })
  }

  private handleAuthentication(context: AuthContext, state: GatewayConnectionState): void {
    if (
      this.stopping ||
      state.closed ||
      state.socket.destroyed ||
      state.authenticated ||
      state.authInFlight ||
      context.method !== 'publickey'
    ) {
      this.authRejections++
      context.reject()
      return
    }
    state.authInFlight = true
    this.trackSetup(
      authenticateGatewayPublicKey(context as PublicKeyAuthContext, this.policy)
        .then(result => {
          if (this.stopping || state.closed || state.socket.destroyed) {
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
        .catch((error: unknown) => {
          this.authRejections++
          this.report({ stage: 'authentication', outcome: 'failed' }, state, error)
          context.reject()
        })
        .finally(() => {
          state.authInFlight = false
        }),
      state,
    )
  }

  private configureSession(session: Session, state: GatewayConnectionState): void {
    const deny = (request: SshGatewayDiagnosticRequest, reject?: () => void): void => {
      this.report(
        {
          stage: 'request',
          outcome: 'rejected',
          reason: 'unsupported_request',
          request,
          replyRequested: typeof reject === 'function',
        },
        state,
      )
      // ssh2 omits reply callbacks when the client sends wantReply=false.
      // Ignoring the request still denies the capability without ending SSH.
      reject?.()
    }
    session.on('pty', (_accept, reject) => deny('pty', reject))
    session.on('env', (_accept, reject) => deny('env', reject))
    session.on('exec', (_accept, reject) => deny('exec', reject))
    session.on('subsystem', (_accept, reject) => deny('subsystem', reject))
    session.on('x11', (_accept, reject) => deny('x11', reject))
    session.on('auth-agent', (_accept, reject) => deny('auth-agent', reject))
    session.on('signal', (_accept, reject) => deny('signal', reject))
    session.on('window-change', (_accept, reject) => deny('window-change', reject))
    session.on('shell', (accept, reject) => {
      this.report({ stage: 'shell', outcome: 'started' }, state)
      const denyShell = (reason: SshGatewayDiagnosticReason): void => {
        this.report(
          {
            stage: 'shell',
            outcome: 'rejected',
            reason,
            replyRequested: typeof reject === 'function',
          },
          state,
        )
        reject?.()
      }
      if (this.stopping) {
        denyShell('shutdown')
        return
      }
      if (state.closed || state.socket.destroyed) {
        denyShell('connection_closed')
        return
      }
      if (!state.authenticated) {
        denyShell('not_authenticated')
        return
      }
      if (state.shellAccepted) {
        denyShell('shell_already_accepted')
        return
      }
      if (state.ticket === null) {
        denyShell('missing_ticket')
        return
      }
      if (state.key === null) {
        denyShell('missing_key')
        return
      }
      if (this.registry.activeRelayCount >= this.config.maxRelays) {
        denyShell('relay_limit')
        return
      }
      const ticket = state.ticket
      const key = state.key
      const channel = accept()
      if (!channel) {
        this.report(
          {
            stage: 'shell',
            outcome: 'failed',
            reason: 'channel_unavailable',
          },
          state,
        )
        state.socket.destroy()
        return
      }
      state.shellAccepted = true
      this.clearChannelTimer(state)
      state.ticket = null
      channel.pause()
      this.report({ stage: 'shell', outcome: 'accepted' }, state)
      this.trackSetup(this.openRelay(state, channel, ticket, key), state)
    })
  }

  private async openRelay(
    state: GatewayConnectionState,
    channel: ServerChannel,
    ticket: string,
    key: SshCanonicalPublicKey,
  ): Promise<void> {
    let relayId: string | null = null
    let stage: SshGatewayDiagnosticStage = 'redemption'
    let channelClosed = false
    const closeChannel = () => {
      if (channelClosed) {
        return
      }
      channelClosed = true
      if (relayId !== null) {
        this.registry.close(relayId, 'natural')
      } else {
        this.report(
          {
            stage: 'shell',
            outcome: 'closed',
            reason: 'stream_closed',
          },
          state,
        )
      }
    }
    // Closure may happen while redemption is awaiting SSH persistence.
    // ssh2's Channel.destroy() is protocol closure, not Node's destroyed flag.
    channel.on('error', (error: Error) => {
      this.report(
        {
          stage: 'relay',
          outcome: 'failed',
          reason: 'channel_error',
        },
        state,
        error,
      )
      closeChannel()
    })
    channel.once('close', closeChannel)
    channel.once('end', closeChannel)
    try {
      this.report({ stage, outcome: 'started' }, state)
      const opening = await this.policy.redeemGatewayTicket(ticket, key, this.config.gatewayInstanceId)
      const id = opening.relayId
      relayId = id
      state.relayId = id
      this.report({ stage, outcome: 'succeeded' }, state)
      stage = 'registration'
      this.report({ stage, outcome: 'started' }, state)
      if (this.stopping || state.closed || state.socket.destroyed || channelClosed) {
        this.report(
          {
            stage,
            outcome: 'rejected',
            reason: this.stopping ? 'shutdown' : 'connection_closed',
          },
          state,
        )
        channel.destroy()
        this.trackDurableClosure(
          this.policy.closeRelay(id, this.config.gatewayInstanceId, RELAY_REGISTRATION_REJECTED_REASON),
          id,
          state,
        )
        state.client?.end()
        return
      }
      const registration = this.registry.register(id, channel, origin => {
        this.onRelayClosed(id, origin, state)
      })
      if (registration !== 'registered') {
        this.report(
          {
            stage,
            outcome: 'rejected',
            reason: registration === 'tombstoned' ? 'relay_tombstoned' : 'registry_capacity',
          },
          state,
        )
        this.trackDurableClosure(
          this.policy.closeRelay(id, this.config.gatewayInstanceId, RELAY_REGISTRATION_REJECTED_REASON),
          id,
          state,
        )
        state.client?.end()
        return
      }
      this.report({ stage, outcome: 'succeeded' }, state)
      stage = 'activation'
      this.report({ stage, outcome: 'started' }, state)
      const activation = await this.policy.activateRelay(id, this.config.gatewayInstanceId)
      if (!this.registry.beginDial(id)) {
        throw new RelayError('relay_closed_before_dial')
      }
      this.report({ stage, outcome: 'succeeded' }, state)
      stage = 'dial'
      this.report({ stage, outcome: 'started' }, state)
      const upstream = await this.dialBranch(id, activation, state)
      this.report({ stage, outcome: 'succeeded' }, state)
      stage = 'pipe'
      this.report({ stage, outcome: 'started' }, state)
      if (!this.registry.activate(id)) {
        upstream.destroy()
        throw new RelayError('relay_closed_before_stream')
      }
      channel.pipe(upstream)
      upstream.pipe(channel)
      channel.resume()
      this.report({ stage, outcome: 'succeeded' }, state)
    } catch (error: unknown) {
      if (stage === 'dial') {
        this.dialFailures++
      }
      this.report({ stage, outcome: 'failed' }, state, error)
      if (relayId !== null) {
        this.registry.close(relayId, 'setup_failure')
      } else {
        channel.destroy()
      }
      state.client?.end()
    }
  }

  private async dialBranch(
    relayId: string,
    activation: SshRelayActivationOutput,
    state: GatewayConnectionState,
  ): Promise<Socket> {
    if (isIP(activation.destination.host) === 0 || activation.destination.port !== 22) {
      throw new RelayError('invalid_destination')
    }
    const upstream = createConnection({
      host: activation.destination.host,
      port: activation.destination.port,
    })
    let connected = false
    upstream.setNoDelay(true)
    upstream.setKeepAlive(true)
    // The temporary dial listener is removed after connect. Stream errors must
    // still be handled for the entire lifetime of the established relay.
    upstream.on('error', (error: Error) => {
      if (!connected) {
        return
      }
      this.report(
        {
          stage: 'relay',
          outcome: 'failed',
          reason: 'upstream_error',
        },
        state,
        error,
      )
      this.registry.close(relayId, 'natural')
    })
    if (!this.registry.attachUpstream(relayId, upstream)) {
      upstream.destroy()
      throw new RelayError('relay_closed_during_dial')
    }
    upstream.once('close', () => {
      this.registry.close(relayId, 'natural')
    })
    return await new Promise<Socket>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        finish(new RelayError('dial_timeout'))
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
      const onConnect = () => {
        connected = true
        finish()
      }
      const onError = (error: Error) => finish(error)
      const onCloseBeforeConnect = () => finish(new RelayError('dial_closed'))
      upstream.once('connect', onConnect)
      upstream.once('error', onError)
      upstream.once('close', onCloseBeforeConnect)
    })
  }

  private onRelayClosed(relayId: string, origin: SshRelayClosureOrigin, state: GatewayConnectionState): void {
    this.report(
      {
        stage: 'relay',
        outcome: 'closed',
        relayId,
        reason:
          origin === 'host'
            ? 'host_revoked'
            : origin === 'shutdown'
              ? 'shutdown'
              : origin === 'setup_failure'
                ? 'setup_failed'
                : 'stream_closed',
      },
      state,
    )
    if (origin === 'host') {
      return
    }
    const reason =
      origin === 'shutdown'
        ? RELAY_SHUTDOWN_REASON
        : origin === 'setup_failure'
          ? RELAY_SETUP_FAILED_REASON
          : RELAY_STREAM_CLOSED_REASON
    this.trackDurableClosure(this.policy.closeRelay(relayId, this.config.gatewayInstanceId, reason), relayId, state)
  }

  private trackSetup(operation: Promise<void>, state: GatewayConnectionState): void {
    const completion = operation
      .catch((error: unknown) => {
        this.report({ stage: 'connection', outcome: 'failed' }, state, error)
        state.socket.destroy()
      })
      .finally(() => {
        this.setupTasks.delete(completion)
      })
    this.setupTasks.add(completion)
  }

  private trackDurableClosure(operation: Promise<unknown>, relayId: string, state: GatewayConnectionState): void {
    const completion = operation
      .then(() => {
        this.report({ stage: 'closure', outcome: 'succeeded', relayId }, state)
      })
      .catch((error: unknown) => {
        this.report({ stage: 'closure', outcome: 'failed', relayId }, state, error)
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

  private report(event: GatewayDiagnosticInput, state?: GatewayConnectionState, error?: unknown): void {
    const callback = this.config.onDiagnostic
    if (!callback) {
      return
    }
    try {
      const diagnostic: SshGatewayDiagnostic = {
        ...event,
        gatewayInstanceId: this.config.gatewayInstanceId,
        ...(state === undefined
          ? {}
          : {
              connectionId: state.id,
              ...(state.relayId === null ? {} : { relayId: state.relayId }),
            }),
        ...(error instanceof RelayError
          ? { reason: error.reason }
          : error === undefined
            ? {}
            : { error: describeError(error) }),
      }
      const completion = callback(diagnostic)
      void Promise.resolve(completion).catch(() => undefined)
    } catch {
      // Diagnostics must never change authentication, relay, or closure behavior.
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
