import path from 'node:path'
import { CapsuleBlueprintRegistry, CapsuleNatsChannel } from '@qiln/core/server'
import { registerCapsuleChannelHandlers } from './channel'
import { OperationSupervisor, WorkerAuthority, type AuthorityLossError } from './coordination'
import { IncusClient } from './incus/client/index'
import { ProjectService } from './services/project'
import { composeCapsuleService, type CapsuleService } from './services/capsule'
import type { WorkerRuntimeConfig, WorkerRuntimeOptions } from './types'

const WORKER_LOG_PREFIX = '[QilnWorker]'
const CHANNEL_LOG_PREFIX = '[QilnWorker CapsuleChannel]'
const BLUEPRINT_LOG_PREFIX = '[QilnWorker Blueprints]'
const AUTHORITY_LOG_PREFIX = '[QilnWorker Authority]'
const DEFAULT_OPERATION_DRAIN_TIMEOUT_MS = 30_000

type ResolvedWorkerRuntimeConfig = WorkerRuntimeConfig & {
  database: NonNullable<WorkerRuntimeConfig['database']>
  nats: NonNullable<WorkerRuntimeConfig['nats']>
  incus: NonNullable<WorkerRuntimeConfig['incus']>
}

class WorkerRuntimeFailStopError extends Error {
  public readonly details?: Record<string, unknown>

  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'WorkerRuntimeFailStopError'
    this.details = details
  }
}

function detailsFromUnknown(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {
    value,
  }
}

function resolveWorkerRuntimeConfig(config?: WorkerRuntimeConfig): ResolvedWorkerRuntimeConfig {
  if (!config?.database?.url) {
    throw new Error(`${WORKER_LOG_PREFIX} Missing required configuration: config.database.url is required for Worker mutation authority.`)
  }
  if (!config.nats) {
    throw new Error(`${WORKER_LOG_PREFIX} Missing required configuration: config.nats is required.`)
  }
  if (!config.incus) {
    throw new Error(`${WORKER_LOG_PREFIX} Missing required configuration: config.incus is required.`)
  }
  return {
    ...config,
    database: config.database,
    nats: config.nats,
    incus: config.incus,
  }
}

/**
 * Standalone privileged Worker runtime.
 *
 * The runtime owns infrastructure connections, operation supervision, and the
 * dedicated PostgreSQL mutation-authority session. PostgreSQL remains
 * authoritative for operation and capsule state.
 */
export class QilnWorkerRuntime {
  public readonly project: ProjectService
  public readonly capsule: CapsuleService
  public readonly incus: IncusClient
  public readonly channel: CapsuleNatsChannel
  public readonly blueprints: CapsuleBlueprintRegistry
  public readonly supervisor: OperationSupervisor
  public readonly authority: WorkerAuthority

  private readonly config: ResolvedWorkerRuntimeConfig

  private started = false
  private disposed = false
  private booting: Promise<void> | null = null
  private channelShutdown: Promise<void> | null = null
  private fatalError: WorkerRuntimeFailStopError | null = null

  constructor(options: WorkerRuntimeOptions) {
    this.config = resolveWorkerRuntimeConfig(options.config)
    this.supervisor = new OperationSupervisor({
      loggerPrefix: `${WORKER_LOG_PREFIX} OperationSupervisor`,
      onOperationRejected: (operationId, error) => {
        console.error(`${WORKER_LOG_PREFIX} Supervised capsule operation '${operationId}' rejected.`, error)
      },
    })
    this.incus = new IncusClient(this.config.incus)
    this.project = new ProjectService(this.incus)
    this.channel = new CapsuleNatsChannel(this.config.nats, {
      loggerPrefix: CHANNEL_LOG_PREFIX,
    })
    this.blueprints = new CapsuleBlueprintRegistry({
      loggerPrefix: BLUEPRINT_LOG_PREFIX,
    })
    this.authority = new WorkerAuthority({
      connectionString: this.config.database.url,
      loggerPrefix: AUTHORITY_LOG_PREFIX,
      onFatalLoss: error => {
        this.handleFatalAuthorityLoss(error)
      },
    })
    this.capsule = composeCapsuleService({
      db: options.db,
      incus: this.incus,
      channel: this.channel,
      project: this.project,
      blueprints: this.blueprints,
      supervisor: this.supervisor,
    })
  }

  public async start(): Promise<void> {
    if (this.disposed) {
      throw new Error(`${WORKER_LOG_PREFIX} Cannot start a disposed Worker runtime. Create a new runtime instance instead.`)
    }
    if (this.started) {
      return
    }
    if (this.booting) {
      await this.booting
      return
    }

    this.booting = this.boot()

    try {
      await this.booting
    } finally {
      this.booting = null
    }
  }

  public async stop(): Promise<void> {
    if (this.disposed) {
      return
    }
    if (this.booting && !this.started) {
      try {
        await this.booting
      } catch {
        // Failed startup owns its cleanup path and disposes the runtime.
        return
      }
    }
    try {
      await this.shutdown()
    } finally {
      this.started = false
      this.disposed = true
      console.log(`${WORKER_LOG_PREFIX} Runtime stopped.`)
    }
  }

  private async boot(): Promise<void> {
    try {
      const blueprintDirectory = this.resolveBlueprintDirectory()

      await this.blueprints.load(blueprintDirectory)
      await this.incus.init()
      await this.channel.start()

      /**
       * Capsule Channel connectivity is established before mutation authority,
       * but no command responders exist yet. The Worker therefore cannot accept
       * operations at this point.
       */
      await this.authority.acquire()
      this.throwIfFailStopped()

      /**
       * Durable nonterminal operations from an earlier process are dispatched
       * to their operation-local abandonment handlers before any provider
       * reconciliation or new command intake.
       */
      await this.capsule.classifyAbandonedOperationsAtStartup()
      this.throwIfFailStopped()

      /**
       * Runtime reconciliation remains observation-only and executes while
       * exclusive Worker authority is still proven.
       */
      await this.capsule.branch.reconcileRuntimeStates()
      this.throwIfFailStopped()

      registerCapsuleChannelHandlers(this)

      this.throwIfFailStopped()
      this.started = true
      console.log(`${WORKER_LOG_PREFIX} Runtime started with mutation authority on PostgreSQL backend ${this.authority.recordedBackendPid}.`)
    } catch (error: unknown) {
      await this.disposeAfterStartupFailure(error)
      throw error
    }
  }

  private async disposeAfterStartupFailure(startupError: unknown): Promise<void> {
    try {
      await this.shutdown()
    } catch (cleanupError: unknown) {
      console.error(`${WORKER_LOG_PREFIX} Startup failed and cleanup also failed.`, {
        startupError: detailsFromUnknown(startupError),
        cleanupError: detailsFromUnknown(cleanupError),
      })
    } finally {
      this.started = false
      this.disposed = true
    }
  }

  /**
   * Performs normal shutdown only while exclusive mutation authority remains
   * proven.
   *
   * CapsuleNatsChannel currently cannot stop command responders independently
   * from closing the connection, so channel shutdown closes command intake
   * before supervised work drains. Terminal invalidation publication may fail
   * during this interval; committed PostgreSQL state remains authoritative.
   *
   * If supervised work does not drain, or mutation authority is lost, this
   * method refuses normal authority release. The host process must terminate to
   * finish the fail-stop path.
   */
  private async shutdown(): Promise<void> {
    this.supervisor.beginShutdown()
    let channelShutdownError: unknown

    try {
      await this.shutdownChannel()
    } catch (error: unknown) {
      channelShutdownError = error
      console.error(`${WORKER_LOG_PREFIX} Capsule Channel shutdown failed while closing command intake.`, error)
    }

    const drain = await this.supervisor.drain(DEFAULT_OPERATION_DRAIN_TIMEOUT_MS)

    if (!drain.settled) {
      const drainError = new WorkerRuntimeFailStopError(
        'Supervised capsule operations did not drain before the shutdown deadline. Normal authority release is prohibited.',
        {
          activeOperationIds: drain.activeOperationIds,
          timeoutMs: DEFAULT_OPERATION_DRAIN_TIMEOUT_MS,
        },
      )

      this.markFailStopped(drainError)
      this.incus.destroy()

      console.error(`${WORKER_LOG_PREFIX} FATAL: Worker shutdown timed out with active capsule operations.`, {
        activeOperationIds: drain.activeOperationIds,
        timeoutMs: DEFAULT_OPERATION_DRAIN_TIMEOUT_MS,
        authorityBackendPid: this.authority.recordedBackendPid,
      })

      throw drainError
    }

    this.incus.destroy()

    if (this.fatalError) {
      console.error(
        `${WORKER_LOG_PREFIX} FATAL: Normal Worker authority release was skipped. Host process termination is required.`,
        this.fatalError,
      )
      throw this.fatalError
    }

    await this.authority.release()

    if (channelShutdownError !== undefined) {
      throw channelShutdownError
    }
  }

  private shutdownChannel(): Promise<void> {
    if (!this.channelShutdown) {
      this.channelShutdown = this.channel.shutdown()
    }
    return this.channelShutdown
  }

  /**
   * Immediately closes mutation intake and provider access when exclusive
   * authority can no longer be proven.
   *
   * Existing promises cannot be forcibly cancelled. Authority is therefore not
   * normally released, and the host process must terminate rather than continue
   * or start a replacement Worker.
   */
  private handleFatalAuthorityLoss(error: AuthorityLossError): void {
    const failStopError = new WorkerRuntimeFailStopError('Worker PostgreSQL mutation authority was lost or became ambiguous.', {
      authorityError: detailsFromUnknown(error),
      activeOperationIds: this.supervisor.activeOperationIds(),
      recordedBackendPid: this.authority.recordedBackendPid,
    })

    this.markFailStopped(failStopError)
    this.supervisor.beginShutdown()
    this.incus.destroy()

    void this.shutdownChannel().catch((channelError: unknown) => {
      console.error(`${WORKER_LOG_PREFIX} Failed to close Capsule Channel intake after authority loss.`, channelError)
    })

    console.error(`${WORKER_LOG_PREFIX} FATAL: Worker entered fail-stop state after authority loss.`, {
      error: detailsFromUnknown(error),
      activeOperationIds: this.supervisor.activeOperationIds(),
      recordedBackendPid: this.authority.recordedBackendPid,
    })
  }

  private markFailStopped(error: WorkerRuntimeFailStopError): void {
    if (!this.fatalError) {
      this.fatalError = error
    }
    this.started = false
    this.supervisor.beginShutdown()
  }

  private throwIfFailStopped(): void {
    if (this.fatalError) {
      throw this.fatalError
    }
    if (!this.authority.isHeld) {
      throw new WorkerRuntimeFailStopError('Worker startup cannot continue without proven mutation authority.', {
        authorityLost: this.authority.isLost,
        recordedBackendPid: this.authority.recordedBackendPid,
      })
    }
  }

  private resolveBlueprintDirectory(): string {
    const configuredPath = this.config.definitions?.path
    return configuredPath ? path.resolve(configuredPath) : path.resolve(process.cwd(), 'catalog', 'blueprints')
  }
}
