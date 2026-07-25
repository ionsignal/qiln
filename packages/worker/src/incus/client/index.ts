import { IncusTransport } from './transport/client'
import { ProjectTransport } from './transport/project'
import { IncusInstancesClient } from './instances'
import { IncusFilesClient } from './files'
import { IncusStorageClient } from './storage/index'
import { IncusProjectsClient } from './projects'
import type { WorkerIncusConfig } from '../../types'

export * from './schemas/response'
export * from './schemas/state'
export * from './schemas/instance'
export * from './schemas/storage'
export * from './schemas/project'

export class IncusClient {
  private readonly transport: IncusTransport

  public readonly instances: IncusInstancesClient
  public readonly files: IncusFilesClient
  public readonly storage: IncusStorageClient
  public readonly projects: IncusProjectsClient

  constructor(config: WorkerIncusConfig = {}) {
    this.transport = new IncusTransport(config)
    const defaultProject = config.project ?? 'default'
    const scoped = new ProjectTransport(this.transport, defaultProject)
    this.projects = new IncusProjectsClient(this.transport)
    this.instances = new IncusInstancesClient(scoped)
    this.files = new IncusFilesClient(scoped)
    this.storage = new IncusStorageClient(scoped)
  }

  /**
   * Pre-flight check to ensure transport connectivity.
   */
  public async init(): Promise<void> {
    await this.transport.init()
  }

  /**
   * Gracefully closes the WebSocket event stream and rejects all in-flight
   * operations.
   */
  public destroy(): void {
    this.transport.destroy()
  }

  /**
   * Returns a set of sub-clients that are strictly scoped to a specific Incus
   * project, reusing the underlying WebSocket connection to prevent resource
   * exhaustion.
   *
   * The existing method name is retained because capsule services outside this
   * refactor scope call it directly.
   */
  public project(project: string) {
    const transport = new ProjectTransport(this.transport, project)
    return {
      instances: new IncusInstancesClient(transport),
      files: new IncusFilesClient(transport),
      storage: new IncusStorageClient(transport),
    }
  }
}
