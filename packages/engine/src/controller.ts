import { CapsuleNatsChannel } from '@qiln/core/server'
import { CapsuleEventHub } from './events/capsule'
import { CapsuleBlueprintService } from './services/blueprints'
import { CapsuleBranchesService } from './services/capsule/branches'
import { CapsuleOperationsService } from './services/capsule/operations'
import { CapsuleSnapshotsService } from './services/capsule/snapshots'
import type { EnginePersistence } from './persistence'
import type { EngineConfig } from './types'

const LOGGER_PREFIX = '[QilnEngine]'
const CHANNEL_LOGGER_PREFIX = `${LOGGER_PREFIX} CapsuleChannel`

export class QilnEngineController {
  public readonly events: CapsuleEventHub
  public readonly channel: CapsuleNatsChannel
  public readonly blueprints: CapsuleBlueprintService
  public readonly capsuleOperations: CapsuleOperationsService
  public readonly capsuleBranches: CapsuleBranchesService
  public readonly capsuleSnapshots: CapsuleSnapshotsService

  private started = false
  private starting: Promise<void> | null = null
  private stopping: Promise<void> | null = null

  constructor(persistence: EnginePersistence, config: EngineConfig = {}) {
    const nats = config.nats
    if (!nats) {
      throw new Error(`${LOGGER_PREFIX} Missing required configuration: config.nats is required.`)
    }
    this.channel = new CapsuleNatsChannel(nats, {
      loggerPrefix: CHANNEL_LOGGER_PREFIX,
    })
    this.events = new CapsuleEventHub(this.channel)
    this.blueprints = new CapsuleBlueprintService(this.channel)
    this.capsuleOperations = new CapsuleOperationsService(persistence, this.channel)
    this.capsuleBranches = new CapsuleBranchesService(persistence, this.channel)
    this.capsuleSnapshots = new CapsuleSnapshotsService(persistence, this.channel)
  }

  public async start(): Promise<void> {
    if (this.stopping) {
      await this.stopping
    }
    if (this.started) {
      return
    }
    if (!this.starting) {
      this.starting = this.open()
    }
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  public async stop(): Promise<void> {
    if (this.starting) {
      try {
        await this.starting
      } catch {
        return
      }
    }
    if (!this.started) {
      return
    }
    if (!this.stopping) {
      this.stopping = this.close()
    }
    try {
      await this.stopping
    } finally {
      this.stopping = null
    }
  }

  private async open(): Promise<void> {
    let opened = false
    try {
      await this.channel.start()
      opened = true
      this.events.start()
      this.started = true
    } catch (error: unknown) {
      this.events.stop()
      this.started = false
      if (opened) {
        try {
          await this.channel.shutdown()
        } catch (shutdownError: unknown) {
          console.error(`${LOGGER_PREFIX} Failed to shut down Capsule Channel after startup failure.`, shutdownError)
        }
      }
      throw error
    }
  }

  private async close(): Promise<void> {
    this.events.stop()
    try {
      await this.channel.shutdown()
    } finally {
      this.started = false
      await this.events.waitForStop()
    }
  }
}
