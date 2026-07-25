import type { Response } from 'undici'
import type {
  IIncusTransport,
  IncusMutationOptions,
  IncusOperationOptions,
  IncusRawMutationOptions,
  IncusRawReadOptions,
  IncusRequestOptions,
} from '../types'

/**
 * Project-scoped proxy over one shared Incus transport.
 *
 * Scoping reuses the same HTTP agent, WebSocket connection, pending-operation
 * registry, and overall operation deadlines.
 */
export class ProjectTransport implements IIncusTransport {
  constructor(
    private readonly transport: IIncusTransport,
    private readonly project: string,
  ) {}

  public async read(
    path: string,
    method: string,
    options?: IncusRequestOptions,
  ): Promise<{ data: unknown; etag?: string }> {
    return await this.transport.read(path, method, {
      ...options,
      project: this.project,
    })
  }

  public async mutate(path: string, method: string, options?: IncusMutationOptions): Promise<void> {
    await this.transport.mutate(path, method, {
      ...options,
      project: this.project,
    })
  }

  public async readRaw(path: string, method: string, options?: IncusRawReadOptions): Promise<Response> {
    return await this.transport.readRaw(path, method, {
      ...options,
      project: this.project,
    })
  }

  public async mutateRaw(path: string, method: string, options?: IncusRawMutationOptions): Promise<void> {
    await this.transport.mutateRaw(path, method, {
      ...options,
      project: this.project,
    })
  }

  public async operation(path: string, method: string, options?: IncusOperationOptions): Promise<void> {
    await this.transport.operation(path, method, {
      ...options,
      project: this.project,
    })
  }
}
