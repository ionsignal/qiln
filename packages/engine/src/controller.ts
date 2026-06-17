import path from 'node:path'
import { IncusClient } from './incus/client/index'
import { InstanceService } from './services/instance'
import { FileService } from './services/file'
import { ProjectService } from './services/project'
import { DefinitionRegistryService } from './services/registry'
import { NatsBroker } from './broker'
import { registerNatsRouters } from './nats'
import type { HostDbContract } from './db'
import type { HostLibraryConfig } from './types'

export class QilnEngineController {
  public readonly project: ProjectService
  public readonly instance: InstanceService
  public readonly file: FileService
  public readonly incus: IncusClient
  public readonly broker: NatsBroker
  public readonly registry: DefinitionRegistryService

  private readonly config: HostLibraryConfig

  constructor(
    private readonly db: HostDbContract,
    config: HostLibraryConfig = {},
  ) {
    if (!config.nats) {
      throw new Error('[QilnEngine] Missing required configuration: config.nats is required.')
    }
    this.config = config
    this.incus = new IncusClient(config.incus)
    this.broker = new NatsBroker(config.nats)
    this.project = new ProjectService(this.incus)
    this.registry = new DefinitionRegistryService()
    this.instance = new InstanceService(this.db, this.incus, this.broker, this.project, this.registry)
    this.file = new FileService(this.db, this.incus, this.project)
  }

  public async start() {
    const configuredPath = this.config.definitions?.path
    const definitionsPath = configuredPath ? path.resolve(configuredPath) : path.resolve(process.cwd(), 'catalog', 'blueprints')
    await this.registry.load(definitionsPath)
    await this.incus.init()
    await this.broker.start()
    registerNatsRouters(this)
  }

  public async stop(): Promise<void> {
    this.incus.destroy()
    await this.broker.shutdown()
  }
}
