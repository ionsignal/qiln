import path from 'node:path'
import { CapsuleNatsChannel } from '@qiln/core/server'
import { CapsuleService } from './services/capsule'
import { CapsuleEventHub } from './events/capsule'
import { DefinitionRegistryService } from './services/registry'
import type { CapsuleBranchHostDbContract } from '@qiln/core/server'
import type { EngineConfig } from './types'

export class QilnEngineController {
  public readonly events: CapsuleEventHub
  public readonly capsule: CapsuleService
  public readonly channel: CapsuleNatsChannel
  public readonly registry: DefinitionRegistryService

  private readonly config: EngineConfig

  constructor(
    private readonly db: CapsuleBranchHostDbContract,
    config: EngineConfig = {},
  ) {
    if (!config.nats) {
      throw new Error('[QilnEngine] Missing required configuration: config.nats is required.')
    }

    this.config = config
    this.channel = new CapsuleNatsChannel(config.nats, {
      loggerPrefix: '[QilnEngine CapsuleChannel]',
    })
    this.registry = new DefinitionRegistryService()
    this.events = new CapsuleEventHub(this.channel)
    this.capsule = new CapsuleService(this.db, this.channel)
  }

  public async start(): Promise<void> {
    const configuredPath = this.config.definitions?.path
    const definitionsPath = configuredPath ? path.resolve(configuredPath) : path.resolve(process.cwd(), 'catalog', 'blueprints')

    let channelStarted = false

    try {
      await this.registry.load(definitionsPath)
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
