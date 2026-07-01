import { IncusTransport, ScopedIncusTransport } from './transport'
import { IncusInstancesClient } from './instances'
import { IncusFilesClient } from './files'
import { IncusStorageClient } from './storage/index'
import { IncusProjectsClient } from './projects'
import type { WorkerIncusConfig } from '../../types'

export class IncusClient {
  private readonly transport: IncusTransport

  public readonly instances: IncusInstancesClient
  public readonly files: IncusFilesClient
  public readonly storage: IncusStorageClient
  public readonly projects: IncusProjectsClient

  constructor(config: WorkerIncusConfig = {}) {
    this.transport = new IncusTransport(config)
    const defaultProject = config.project ?? 'default'
    const scoped = new ScopedIncusTransport(this.transport, defaultProject)
    this.projects = new IncusProjectsClient(this.transport)
    this.instances = new IncusInstancesClient(scoped)
    this.files = new IncusFilesClient(scoped)
    this.storage = new IncusStorageClient(scoped)
  }

  /**
   * Pre-flight check to ensure transport connectivity.
   */
  public async init(): Promise<void> {
    return this.transport.init()
  }

  /**
   * Gracefully closes the WebSocket event stream and rejects all in-flight operations.
   */
  public destroy(): void {
    return this.transport.destroy()
  }

  /**
   * Returns a set of sub-clients that are strictly scoped to a specific Incus project,
   * reusing the underlying WebSocket connection to prevent resource exhaustion.
   */
  public UseProject(project: string) {
    const scopedTransport = new ScopedIncusTransport(this.transport, project)
    return {
      instances: new IncusInstancesClient(scopedTransport),
      files: new IncusFilesClient(scopedTransport),
      storage: new IncusStorageClient(scopedTransport),
    }
  }
}
