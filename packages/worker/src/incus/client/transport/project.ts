import type { Response } from 'undici'
import type { IIncusTransport, IncusRawRequestOptions, IncusRequestOptions } from '../types'

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

  public async request(
    path: string,
    method: string,
    options?: IncusRequestOptions,
  ): Promise<{ data: unknown; etag?: string }> {
    return await this.transport.request(path, method, {
      ...options,
      project: this.project,
    })
  }

  public async raw(path: string, method: string, options?: IncusRawRequestOptions): Promise<Response> {
    return await this.transport.raw(path, method, {
      ...options,
      project: this.project,
    })
  }

  public async operation(path: string, method: string, options?: IncusRequestOptions): Promise<void> {
    await this.transport.operation(path, method, {
      ...options,
      project: this.project,
    })
  }
}
