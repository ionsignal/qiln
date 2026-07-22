import { buildIncusFileHeaders } from '../utils'
import type { IIncusTransport, IncusFilePushOptions } from './types'

export class IncusFilesClient {
  constructor(private readonly transport: IIncusTransport) {}

  /**
   * Reads a file from the container as raw bytes.
   */
  public async read(instance: string, path: string): Promise<{ data: Uint8Array; etag?: string }> {
    const queryPath = encodeURIComponent(path)
    const res = await this.transport.raw(`/instances/${encodeURIComponent(instance)}/files?path=${queryPath}`, 'GET')
    const arrayBuffer = await res.arrayBuffer()
    const etag = res.headers.get('etag') ?? undefined
    return { data: new Uint8Array(arrayBuffer), etag }
  }

  /**
   * Pushes a file to the container disk, injecting X-INCUS headers for
   * ownership.
   */
  public async write(
    instance: string,
    path: string,
    content: Uint8Array | string,
    options: IncusFilePushOptions = {},
  ): Promise<void> {
    const queryPath = encodeURIComponent(path)
    const headers = buildIncusFileHeaders(options)
    await this.transport.raw(`/instances/${encodeURIComponent(instance)}/files?path=${queryPath}`, 'POST', {
      body: content,
      headers,
    })
  }

  /**
   * Deletes a file from the container.
   */
  public async delete(instance: string, path: string): Promise<void> {
    const queryPath = encodeURIComponent(path)
    // DELETE returns a standard sync JSON response, so we can use the standard request wrapper
    await this.transport.request(`/instances/${encodeURIComponent(instance)}/files?path=${queryPath}`, 'DELETE')
  }
}
