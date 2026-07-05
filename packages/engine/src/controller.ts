import { CapsuleNatsChannel } from '@qiln/core/server'
import { CapsuleBranchService } from './services/capsule/branch'
import { CapsuleBlueprintService } from './services/capsule/blueprints'
import { CapsuleEventHub } from './events/capsule'
import type { CapsuleBranchHostDbContract } from '@qiln/core/server'
import type { EngineConfig } from './types'

export class QilnEngineController {
  public readonly events: CapsuleEventHub
  public readonly channel: CapsuleNatsChannel
  public readonly blueprints: CapsuleBlueprintService
  public readonly capsule: CapsuleBranchService

  constructor(
    private readonly db: CapsuleBranchHostDbContract,
    config: EngineConfig = {},
  ) {
    if (!config.nats) {
      throw new Error('[QilnEngine] Missing required configuration: config.nats is required.')
    }
    this.channel = new CapsuleNatsChannel(config.nats, {
      loggerPrefix: '[QilnEngine CapsuleChannel]',
    })
    this.events = new CapsuleEventHub(this.channel)
    this.blueprints = new CapsuleBlueprintService(this.channel)
    this.capsule = new CapsuleBranchService(this.db, this.channel)
  }

  public async start(): Promise<void> {
    let channelStarted = false
    try {
      await this.channel.start()
      channelStarted = true
      this.events.start()
    } catch (error: unknown) {
      this.events.stop()
      if (channelStarted) {
        try {
          await this.channel.shutdown()
        } catch (shutdownError: unknown) {
          console.error('[QilnEngine] Failed to shut down Capsule Channel after startup failure.', shutdownError)
        }
      }
      throw error
    }
  }

  public async stop(): Promise<void> {
    this.events.stop()
    try {
      await this.channel.shutdown()
    } finally {
      await this.events.waitForStop()
    }
  }
}
