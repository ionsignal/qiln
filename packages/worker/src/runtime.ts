import path from 'node:path'

import { registerCapsuleChannelHandlers } from './channel'
import { IncusClient } from './incus/client/index'
import { CapsuleService } from './services/capsule'
import { ProjectService } from './services/project'
import { CapsuleBlueprintRegistry, CapsuleNatsChannel } from '@qiln/core/server'
import type { WorkerRuntimeConfig, WorkerRuntimeOptions } from './types'

const WORKER_LOG_PREFIX = '[QilnWorker]'
const CHANNEL_LOG_PREFIX = '[QilnWorker CapsuleChannel]'
const BLUEPRINT_LOG_PREFIX = '[QilnWorker Blueprints]'

type ResolvedWorkerRuntimeConfig = WorkerRuntimeConfig & {
  nats: NonNullable<WorkerRuntimeConfig['nats']>
  incus: NonNullable<WorkerRuntimeConfig['incus']>
}

function resolveWorkerRuntimeConfig(config?: WorkerRuntimeConfig): ResolvedWorkerRuntimeConfig {
  if (!config?.nats) {
    throw new Error(`${WORKER_LOG_PREFIX} Missing required configuration: config.nats is required.`)
  }

  if (!config.incus) {
    throw new Error(`${WORKER_LOG_PREFIX} Missing required configuration: config.incus is required.`)
  }

  return {
    ...config,
    nats: config.nats,
    incus: config.incus,
  }
}

/**
 * Standalone privileged Worker runtime.
 *
 * The runtime owns infrastructure connections and composes one capsule-domain
 * façade. Capsule services own lifecycle policy, durable accounting, resource
 * ownership verification, and provider mutation fences.
 */
export class QilnWorkerRuntime {
  public readonly project: ProjectService
  public readonly capsule: CapsuleService
  public readonly incus: IncusClient
  public readonly channel: CapsuleNatsChannel
  public readonly blueprints: CapsuleBlueprintRegistry

  private readonly config: ResolvedWorkerRuntimeConfig

  private started = false
  private disposed = false
  private booting: Promise<void> | null = null

  constructor(options: WorkerRuntimeOptions) {
    this.config = resolveWorkerRuntimeConfig(options.config)
    this.incus = new IncusClient(this.config.incus)
    this.project = new ProjectService(this.incus)
    this.channel = new CapsuleNatsChannel(this.config.nats, { loggerPrefix: CHANNEL_LOG_PREFIX })
    this.blueprints = new CapsuleBlueprintRegistry({ loggerPrefix: BLUEPRINT_LOG_PREFIX })
    this.capsule = new CapsuleService(options.db, this.incus, this.channel, this.project, this.blueprints)
  }

  public async start(): Promise<void> {
    if (this.disposed) {
      throw new Error(`${WORKER_LOG_PREFIX} Cannot start a disposed worker runtime. Create a new runtime instance instead.`)
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
        // Failed startup owns its cleanup path and marks the runtime disposed.
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
       * The MVP has no lease, scheduler, retry, or operation runner. A
       * nonterminal inline lifecycle operation from an earlier process is
       * uncertain and must be marked cleanup-required before runtime
       * reconciliation or new commands are accepted.
       */
      await this.capsule.markAbandonedOperationsCleanupRequired()

      /**
       * Runtime reconciliation is mandatory and observation-only. It converges
       * branch status from live Incus state without retrying abandoned start or
       * stop mutations.
       */
      await this.capsule.branch.reconcileRuntimeStates()

      registerCapsuleChannelHandlers(this)

      this.started = true
      console.log(`${WORKER_LOG_PREFIX} Runtime started.`)
    } catch (error: unknown) {
      await this.dispose()
      throw error
    }
  }

  private async dispose(): Promise<void> {
    try {
      await this.shutdown()
    } catch (cleanupError: unknown) {
      console.error(`${WORKER_LOG_PREFIX} Startup failed and cleanup also failed:`, cleanupError)
    } finally {
      this.started = false
      this.disposed = true
    }
  }

  private async shutdown(): Promise<void> {
    try {
      await this.channel.shutdown()
    } finally {
      this.incus.destroy()
    }
  }

  private resolveBlueprintDirectory(): string {
    const configuredPath = this.config.definitions?.path
    return configuredPath ? path.resolve(configuredPath) : path.resolve(process.cwd(), 'catalog', 'blueprints')
  }
}
