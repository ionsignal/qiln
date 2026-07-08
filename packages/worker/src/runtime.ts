import path from 'node:path'
import { CapsuleBlueprintRegistry, CapsuleNatsChannel } from '@qiln/core/server'
import { IncusClient } from './incus/client/index'
import { CapsuleBranchRuntimeService } from './services/capsule/branch'
import { FileService } from './services/file'
import { ProjectService } from './services/project'
import { registerCapsuleChannelHandlers } from './channel'
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
 * Standalone privileged worker runtime.
 *
 * This runtime owns Incus/ZFS mutation privileges and exposes the narrow capsule
 * command surface through the Capsule Channel. It intentionally has no Fastify,
 * Vike, Vue, or tRPC dependency.
 */
export class QilnWorkerRuntime {
  public readonly project: ProjectService
  public readonly capsule: CapsuleBranchRuntimeService
  public readonly file: FileService
  public readonly incus: IncusClient
  public readonly channel: CapsuleNatsChannel
  public readonly blueprints: CapsuleBlueprintRegistry

  private readonly config: ResolvedWorkerRuntimeConfig
  private readonly reconcileOnStart: boolean

  private started = false
  private disposed = false
  private booting: Promise<void> | null = null

  constructor(options: WorkerRuntimeOptions) {
    this.config = resolveWorkerRuntimeConfig(options.config)
    this.reconcileOnStart = options.reconcileOnStart ?? false
    this.incus = new IncusClient(this.config.incus)
    this.channel = new CapsuleNatsChannel(this.config.nats, {
      loggerPrefix: CHANNEL_LOG_PREFIX,
    })
    this.project = new ProjectService(this.incus)
    this.blueprints = new CapsuleBlueprintRegistry({
      loggerPrefix: BLUEPRINT_LOG_PREFIX,
    })
    this.capsule = new CapsuleBranchRuntimeService(options.db, this.incus, this.channel, this.project, this.blueprints)
    this.file = new FileService(options.db, this.incus, this.project)
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
        // Failed startup owns its own cleanup path and marks the runtime disposed.
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
      const blueprintDir = this.resolveBlueprintDirectory()

      await this.blueprints.load(blueprintDir)
      await this.incus.init()
      await this.channel.start()

      registerCapsuleChannelHandlers(this)

      if (this.reconcileOnStart) {
        await this.capsule.reconcile()
      }
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
