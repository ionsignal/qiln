import { buildIncusFileHeaders } from '../utils'
import type { IIncusTransport, IncusFilePushOptions } from './types'

export class IncusFilesClient {
  constructor(private readonly transport: IIncusTransport) {}

  /**
   * Reads a file from the container as raw bytes.
   */
  public async read(instance: string, path: string): Promise<{ data: Uint8Array; etag?: string }> {
    const queryPath = encodeURIComponent(path)
    const response = await this.transport.readRaw(
      `/instances/${encodeURIComponent(instance)}/files?path=${queryPath}`,
      'GET',
    )
    const arrayBuffer = await response.arrayBuffer()
    const etag = response.headers.get('etag') ?? undefined
    return {
      data: new Uint8Array(arrayBuffer),
      etag,
    }
  }

  /**
   * Pushes a file to the container disk, injecting X-Incus headers for
   * ownership.
   *
   * A malformed or ambiguous response is an uncertain provider mutation outcome
   * rather than a definite validation failure.
   */
  public async write(
    instance: string,
    path: string,
    content: Uint8Array | string,
    options: IncusFilePushOptions = {},
  ): Promise<void> {
    const queryPath = encodeURIComponent(path)
    const headers = buildIncusFileHeaders(options)
    await this.transport.mutateRaw(`/instances/${encodeURIComponent(instance)}/files?path=${queryPath}`, 'POST', {
      body: content,
      headers,
    })
  }

  /**
   * Deletes a file from the container.
   *
   * The transport validates a synchronous Incus mutation response. An
   * unreadable or malformed response is treated as an uncertain provider
   * outcome rather than a definite deletion failure.
   */
  public async delete(instance: string, path: string): Promise<void> {
    const queryPath = encodeURIComponent(path)
    await this.transport.mutate(`/instances/${encodeURIComponent(instance)}/files?path=${queryPath}`, 'DELETE')
  }
}
