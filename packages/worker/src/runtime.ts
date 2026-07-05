import path from 'node:path'
import { CapsuleBlueprintRegistry, CapsuleNatsChannel } from '@qiln/core/server'
import { IncusClient } from './incus/client/index'
import { CapsuleBranchRuntimeService } from './services/capsule/branch'
import { FileService } from './services/file'
import { ProjectService } from './services/project'
import { registerCapsuleChannelHandlers } from './channel'
import type { WorkerRuntimeConfig, WorkerRuntimeOptions } from './types'

type ResolvedWorkerRuntimeConfig = WorkerRuntimeConfig & {
  nats: NonNullable<WorkerRuntimeConfig['nats']>
  incus: NonNullable<WorkerRuntimeConfig['incus']>
}

function resolveWorkerRuntimeConfig(config?: WorkerRuntimeConfig): ResolvedWorkerRuntimeConfig {
  if (!config?.nats) {
    throw new Error('[QilnWorker] Missing required configuration: config.nats is required.')
  }

  if (!config.incus) {
    throw new Error('[QilnWorker] Missing required configuration: config.incus is required.')
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

  constructor(options: WorkerRuntimeOptions) {
    this.config = resolveWorkerRuntimeConfig(options.config)
    this.reconcileOnStart = options.reconcileOnStart ?? false
    this.incus = new IncusClient(this.config.incus)
    this.channel = new CapsuleNatsChannel(this.config.nats, {
      loggerPrefix: '[QilnWorker CapsuleChannel]',
    })
    this.project = new ProjectService(this.incus)
    this.blueprints = new CapsuleBlueprintRegistry({
      loggerPrefix: '[QilnWorker Blueprints]',
    })
    this.capsule = new CapsuleBranchRuntimeService(options.db, this.incus, this.channel, this.project, this.blueprints)
    this.file = new FileService(options.db, this.incus, this.project)
  }

  public async start(): Promise<void> {
    if (this.started) {
      return
    }

    try {
      const definitionsPath = this.resolveDefinitionsPath()

      await this.blueprints.load(definitionsPath)
      await this.incus.init()
      await this.channel.start()

      registerCapsuleChannelHandlers(this)

      if (this.reconcileOnStart) {
        await this.capsule.reconcile()
      }
      this.started = true
      console.log('[QilnWorker] Runtime started.')
    } catch (error: unknown) {
      try {
        await this.stop()
      } catch (cleanupError: unknown) {
        console.error('[QilnWorker] Startup failed and cleanup also failed:', cleanupError)
      }

      throw error
    }
  }

  public async stop(): Promise<void> {
    try {
      await this.channel.shutdown()
    } finally {
      this.incus.destroy()
      this.started = false
      console.log('[QilnWorker] Runtime stopped.')
    }
  }

  private resolveDefinitionsPath(): string {
    const configuredPath = this.config.definitions?.path
    return configuredPath ? path.resolve(configuredPath) : path.resolve(process.cwd(), 'catalog', 'blueprints')
  }
}
