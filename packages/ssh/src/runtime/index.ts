import { CapsuleNatsChannel } from '@qiln/core/server'
import { QilnSshGateway } from '../gateway/server'
import { registerSshAccessHandlers, registerSshControlHandlers } from '../host/channel/index'
import { sshConflict } from '../host/errors'
import { SshPolicy } from '../host/policy'
import { SshAuthorizedKeysSyncDispatcher } from '../host/sync'
import { SshAuthority } from './authority'
import type { SshRuntimeOptions } from './types'

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000

export * from './authority'
export * from './types'

/**
 * Composes one standalone-capable SSH authority.
 *
 * Singleton acquisition and relay recovery precede command registration and
 * public gateway admission. Normal shutdown closes admission, drains accepted
 * work, and releases the lock last. Fatal loss requires process termination.
 */
export class SshRuntime {
  public readonly policy: SshPolicy

  private readonly authority: SshAuthority
  private readonly channel: CapsuleNatsChannel
  private readonly synchronization: SshAuthorizedKeysSyncDispatcher
  private readonly gateway: QilnSshGateway | null
  private readonly shutdownTimeoutMs: number
  private accepting = false
  private started = false
  private disposed = false
  private booting: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private channelShutdown: Promise<void> | null = null
  private fatalError: Error | null = null

  constructor(private readonly options: SshRuntimeOptions) {
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs <= 0 ||
      this.shutdownTimeoutMs > 2_147_483_647
    ) {
      throw new RangeError('SSH runtime shutdown timeout must be a positive integer within the supported timer range.')
    }
    if (options.gateway && !options.policy.enabled) {
      throw new Error('The SSH gateway cannot be enabled while SSH policy is disabled.')
    }
    if (options.gateway && options.policy.ticketTtlMs <= options.gateway.channelOpenTimeoutMs) {
      throw new Error('SSH ticket TTL must be greater than the gateway channel-open timeout.')
    }
    this.authority = new SshAuthority({
      connectionString: options.connectionString,
      onFatalLoss: error => {
        this.fail(error)
      },
    })
    this.channel = new CapsuleNatsChannel(options.nats, {
      loggerPrefix: '[QilnSSH CapsuleChannel]',
    })
    this.synchronization = new SshAuthorizedKeysSyncDispatcher(options.persistence, this.channel, options.logger)
    this.policy = new SshPolicy(options.persistence, options.policy, this.synchronization, () => {
      this.assertAdmission()
    })
    this.gateway = options.gateway ? new QilnSshGateway(options.gateway, this.policy) : null
    if (this.gateway) {
      this.policy.setRelayCloser(this.gateway)
    }
  }

  public async start(): Promise<void> {
    if (this.disposed || this.fatalError) {
      throw new Error('A disposed SSH runtime cannot restart. Create a new runtime instance.')
    }
    if (this.started) {
      return
    }
    if (!this.booting) {
      this.booting = this.boot()
    }
    await this.booting
  }

  public async stop(): Promise<void> {
    if (this.booting && !this.started && !this.stopping) {
      await this.booting.catch(() => undefined)
    }
    await this.shutdown()
  }

  private async boot(): Promise<void> {
    try {
      await this.authority.acquire()
      this.assertStartupAuthority()
      await this.channel.start()
      this.assertStartupAuthority()
      this.accepting = true
      let recoveredRelayCount = 0
      if (this.gateway && this.options.gateway) {
        recoveredRelayCount = await this.policy.recoverGatewayRelays(this.options.gateway.gatewayInstanceId)
        await this.authority.verify()
        this.assertStartupAuthority()
        await this.gateway.start()
        this.assertStartupAuthority()
      }
      registerSshAccessHandlers(this.channel, this.policy)
      registerSshControlHandlers(this.channel, this.policy)
      this.started = true
      this.options.logger.info(
        {
          authorityBackendPid: this.authority.recordedBackendPid,
          gatewayEnabled: this.gateway !== null,
          recoveredRelayCount,
        },
        '[SSH] SSH authority started.',
      )
    } catch (error: unknown) {
      await this.shutdown().catch(() => undefined)
      throw error
    }
  }

  private shutdown(): Promise<void> {
    if (!this.stopping) {
      this.accepting = false
      this.started = false
      this.disposed = true
      this.stopping = this.stopRuntime()
    }
    return this.stopping
  }

  private async stopRuntime(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('SSH runtime shutdown timed out. Normal singleton authority release is prohibited.'))
      }, this.shutdownTimeoutMs)
    })
    try {
      await Promise.race([this.cleanup(), timeout])
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error('SSH runtime shutdown failed.')
      this.fail(failure)
      throw failure
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }

  private async cleanup(): Promise<void> {
    // Closing the channel stops new RPC intake. Detached key synchronization
    // may fail during shutdown; it is never authorization authority.
    const closures = await Promise.allSettled([this.gateway?.stop() ?? Promise.resolve(), this.closeChannel()])
    await this.policy.drain()
    await this.synchronization.stop()
    if (closures.some(result => result.status === 'rejected')) {
      throw new Error('SSH gateway or channel shutdown could not be completed.')
    }
    if (this.fatalError || this.authority.isLost) {
      throw this.fatalError ?? new Error('SSH authority was lost during shutdown.')
    }
    await this.authority.release()
    this.options.logger.info({}, '[SSH] SSH authority stopped.')
  }

  private closeChannel(): Promise<void> {
    if (!this.channelShutdown) {
      this.channelShutdown = this.channel.shutdown()
    }
    return this.channelShutdown
  }

  private fail(error: Error): void {
    if (this.fatalError) {
      return
    }
    this.fatalError = error
    this.accepting = false
    this.started = false
    // Gateway stop closes existing sockets before its first await. The process
    // callback must still terminate because accepted promises cannot be cancelled.
    void this.gateway?.stop().catch(() => undefined)
    void this.shutdown().catch(() => undefined)
    this.options.logger.error(
      {
        authorityBackendPid: this.authority.recordedBackendPid,
        failure: error.message,
      },
      '[SSH] SSH authority entered fail-stop state. Process termination is required.',
    )
    this.options.onFatal(error)
  }

  private assertAdmission(): void {
    if (!this.accepting || this.fatalError || !this.authority.isHeld) {
      throw sshConflict('SSH authority is not accepting requests.')
    }
  }

  private assertStartupAuthority(): void {
    if (this.disposed || this.fatalError || !this.authority.isHeld) {
      throw this.fatalError ?? new Error('SSH startup cannot continue without exclusive authority.')
    }
  }
}
